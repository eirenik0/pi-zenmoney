import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Data, Effect, Either } from "effect";
import { Type } from "typebox";

import {
	PERSONAL_REGISTER_COLUMNS,
	PERSONAL_REGISTER_PRESERVED_FIELDS,
	PREVIEW_LINES,
} from "./constants.ts";
import { resolveSecretReference } from "./secret-refs.ts";
import type {
	BankTransactionRow,
	CurrencyTotals,
	PersonalAccountPolicy,
	PersonalClassificationRules,
	PersonalRegisterResult,
	ResolvedAccount,
	ZenMoneyAccount,
	ZenMoneyCategory,
	ZenMoneyCompany,
	ZenMoneyInstrument,
	ZenMoneyMerchant,
	ZenMoneySnapshot,
	ZenMoneyTransaction,
} from "./types.ts";

class ZenMoneyCommandError extends Data.TaggedError("ZenMoneyCommandError")<{
	message: string;
}> {}

function toZenMoneyCommandError(error: unknown): ZenMoneyCommandError {
	return new ZenMoneyCommandError({
		message: error instanceof Error ? error.message : String(error),
	});
}

type CommandContext = {
	cwd: string;
	signal?: AbortSignal;
	ui: {
		notify(message: string, level: string): void;
	};
};

function runZenMoneyBoundary(
	ctx: CommandContext,
	effect: Effect.Effect<void, ZenMoneyCommandError>,
) {
	return Effect.runPromise(
		Effect.catchAll(effect, (error) =>
			Effect.sync(() => {
				ctx.ui.notify(error.message, "error");
			}),
		),
	);
}

function effectFromZenMoneyPromise<T>(
	thunk: () => Promise<T>,
): Effect.Effect<T, ZenMoneyCommandError> {
	return Effect.tryPromise({ try: thunk, catch: toZenMoneyCommandError });
}

let snapshotCache: { token: string; snapshot: ZenMoneySnapshot } | undefined;

function renderPreview(text: string, expanded: boolean, theme: Theme) {
	const mdTheme = getMarkdownTheme();
	if (expanded) return new Markdown(text, 0, 0, mdTheme);

	const lines = text.split("\n");
	if (lines.length <= PREVIEW_LINES) return new Markdown(text, 0, 0, mdTheme);

	const preview = lines.slice(0, PREVIEW_LINES).join("\n");
	return new Text(
		`${preview}\n${theme.fg("dim", `… ${lines.length - PREVIEW_LINES} more lines`)}`,
		0,
		0,
	);
}

function renderToolResult(
	result: { content?: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
) {
	const text = result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
	return renderPreview(text || "(empty)", options.expanded, theme);
}

function normalizeText(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function normalizeDigits(value: string): string {
	return value.replace(/\D+/g, "");
}

function trimText(text: string, maxLines = 120, maxChars = 12000): string {
	const lines = text.split("\n");
	let trimmed = lines.slice(0, maxLines).join("\n");
	if (trimmed.length > maxChars) trimmed = `${trimmed.slice(0, maxChars)}\n… output truncated`;
	if (lines.length > maxLines) trimmed += `\n… ${lines.length - maxLines} more lines`;
	return trimmed;
}

function formatNumber(value: number): string {
	return value.toFixed(2).replace(/\.00$/, "");
}

function formatMoney(value: number | undefined, currency: string | undefined): string {
	if (value === undefined || Number.isNaN(value)) return "—";
	return `${formatNumber(value)}${currency ? ` ${currency}` : ""}`;
}

function csvCell(value: string | number | undefined): string {
	const text = value === undefined ? "" : String(value);
	if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
	return text;
}

function buildCsv(headers: string[], rows: Array<Array<string | number | undefined>>): string {
	const lines = [headers.map((header) => csvCell(header)).join(",")];
	for (const row of rows) lines.push(row.map((value) => csvCell(value)).join(","));
	return `${lines.join("\n")}\n`;
}

function parseMonthPeriod(period?: string): string | undefined {
	if (!period) return undefined;
	return /^\d{4}-\d{2}$/.test(period) ? period : undefined;
}

function zenMoneySetupHint(): string {
	return [
		"ZenMoney token is not configured.",
		"",
		"Set `ZENMONEY_TOKEN` before starting Pi.",
		"The value may be a raw token, an `op://` 1Password reference, or a literal `op read ...` / `$(op read ...)` string.",
		"Then use `/zen-accounts` to discover selectable accounts by id, title, or syncID.",
		"",
		"The extension stays separate from accounting automation because the ZenMoney profile may include mixed personal and business accounts.",
	].join("\n");
}

async function getZenMoneyToken(): Promise<string | undefined> {
	const raw = process.env.ZENMONEY_TOKEN?.trim();
	if (!raw) return undefined;
	return resolveSecretReference(raw, "ZenMoney token");
}

function getZenMoneyBaseUrl(): string {
	return (process.env.ZENMONEY_API_BASE_URL?.trim() || "https://api.zenmoney.ru").replace(
		/\/+$/,
		"",
	);
}

async function fetchZenMoneySnapshot(force = false): Promise<ZenMoneySnapshot> {
	const token = await getZenMoneyToken();
	if (!token) throw new Error(zenMoneySetupHint());

	if (
		!force &&
		snapshotCache?.token === token &&
		Date.now() - snapshotCache.snapshot.fetchedAt < 60_000
	) {
		return snapshotCache.snapshot;
	}

	const response = await fetch(`${getZenMoneyBaseUrl()}/v8/diff/`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			currentClientTimestamp: Math.floor(Date.now() / 1000),
			serverTimestamp: 0,
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`ZenMoney API request failed (${response.status} ${response.statusText}). ${body.slice(0, 300)}`.trim(),
		);
	}

	const payload = (await response.json()) as Partial<ZenMoneySnapshot> & {
		serverTimestamp?: number;
	};
	const snapshot: ZenMoneySnapshot = {
		fetchedAt: Date.now(),
		serverTimestamp: payload.serverTimestamp ?? 0,
		instruments: Array.isArray(payload.instruments)
			? payload.instruments
			: Array.isArray((payload as { instrument?: ZenMoneyInstrument[] }).instrument)
				? ((payload as { instrument?: ZenMoneyInstrument[] }).instrument ?? [])
				: [],
		companies: Array.isArray(payload.companies)
			? payload.companies
			: Array.isArray((payload as { company?: ZenMoneyCompany[] }).company)
				? ((payload as { company?: ZenMoneyCompany[] }).company ?? [])
				: [],
		accounts: Array.isArray(payload.accounts)
			? payload.accounts
			: Array.isArray((payload as { account?: ZenMoneyAccount[] }).account)
				? ((payload as { account?: ZenMoneyAccount[] }).account ?? [])
				: [],
		merchants: Array.isArray(payload.merchants)
			? payload.merchants
			: Array.isArray((payload as { merchant?: ZenMoneyMerchant[] }).merchant)
				? ((payload as { merchant?: ZenMoneyMerchant[] }).merchant ?? [])
				: [],
		transactions: Array.isArray(payload.transactions)
			? payload.transactions
			: Array.isArray((payload as { transaction?: ZenMoneyTransaction[] }).transaction)
				? ((payload as { transaction?: ZenMoneyTransaction[] }).transaction ?? [])
				: [],
		tags: Array.isArray(payload.tags)
			? payload.tags
			: Array.isArray((payload as { tag?: ZenMoneyCategory[] }).tag)
				? ((payload as { tag?: ZenMoneyCategory[] }).tag ?? [])
				: [],
	};

	snapshotCache = { token, snapshot };
	return snapshot;
}

function mapById<T extends { id: string | number }>(rows: T[]): Map<T["id"], T> {
	return new Map(rows.map((row) => [row.id, row]));
}

function resolvedAccount(snapshot: ZenMoneySnapshot, account: ZenMoneyAccount): ResolvedAccount {
	const instrumentsById = mapById(snapshot.instruments);
	const companiesById = mapById(snapshot.companies);
	const instrument = account.instrument ? instrumentsById.get(account.instrument) : undefined;
	const company = account.company ? companiesById.get(account.company) : undefined;
	return {
		account,
		currency: instrument?.shortTitle || instrument?.title || "UNKNOWN",
		company: company?.title || company?.fullTitle || "—",
	};
}

function accountMatchesSelector(account: ResolvedAccount, selector: string): boolean {
	const normalizedSelector = normalizeText(selector);
	const selectorDigits = normalizeDigits(selector);
	const accountId = account.account.id;
	const title = account.account.title || "";
	const company = account.company;
	const syncIds = account.account.syncID ?? [];

	if (normalizeText(accountId) === normalizedSelector) return true;
	if (normalizeText(title).includes(normalizedSelector)) return true;
	if (normalizeText(company).includes(normalizedSelector)) return true;
	if (
		syncIds.some(
			(syncId) =>
				normalizeText(syncId) === normalizedSelector ||
				normalizeText(syncId).includes(normalizedSelector),
		)
	)
		return true;

	if (selectorDigits) {
		if (normalizeDigits(accountId).endsWith(selectorDigits)) return true;
		if (syncIds.some((syncId) => normalizeDigits(syncId).endsWith(selectorDigits))) return true;
	}

	return false;
}

function dedupeText(values: Array<string | undefined | null>): string {
	const seen = new Set<string>();
	const unique = values
		.map((value) => value?.trim())
		.filter((value): value is string => Boolean(value))
		.filter((value) => {
			const key = normalizeText(value);
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	return unique.join(" | ");
}

function normalizeTransactionRows(
	snapshot: ZenMoneySnapshot,
	selectedAccounts: ResolvedAccount[],
): BankTransactionRow[] {
	const accountsById = new Map(
		snapshot.accounts.map((account) => [account.id, resolvedAccount(snapshot, account)]),
	);
	const merchantsById = new Map(
		snapshot.merchants.map((merchant) => [merchant.id, merchant.title || merchant.id]),
	);
	const instrumentsById = new Map(
		snapshot.instruments.map((instrument) => [
			instrument.id,
			instrument.shortTitle || instrument.title || String(instrument.id),
		]),
	);
	const tagsById = new Map(
		(snapshot.tags ?? []).map((tag) => [String(tag.id), tag.title || String(tag.id)]),
	);
	const rows: BankTransactionRow[] = [];

	for (const transaction of snapshot.transactions) {
		if (transaction.deleted || !transaction.date) continue;

		for (const selected of selectedAccounts) {
			const isIncome = transaction.incomeAccount === selected.account.id;
			const isOutcome = transaction.outcomeAccount === selected.account.id;
			if (!isIncome && !isOutcome) continue;

			let amount = 0;
			let direction = "transaction";
			if (isIncome && !isOutcome) {
				amount = transaction.income ?? 0;
				direction = "income";
			} else if (isOutcome && !isIncome) {
				amount = -(transaction.outcome ?? 0);
				direction = "outcome";
			} else {
				amount = (transaction.income ?? 0) - (transaction.outcome ?? 0);
				direction = amount < 0 ? "outcome" : "income";
				if (amount === 0 && (transaction.income ?? 0) > 0) amount = transaction.income ?? 0;
				if (amount === 0 && (transaction.outcome ?? 0) > 0) amount = -(transaction.outcome ?? 0);
			}

			const counterpartAccountId = isOutcome
				? transaction.incomeAccount
				: transaction.outcomeAccount;
			const counterpartAccount = counterpartAccountId
				? accountsById.get(counterpartAccountId)
				: undefined;
			const merchantTitle = transaction.merchant
				? merchantsById.get(transaction.merchant)
				: undefined;
			const partner = dedupeText([
				counterpartAccount?.account.title,
				merchantTitle,
				transaction.payee,
				transaction.originalPayee,
			]);
			const description = dedupeText([
				transaction.comment,
				merchantTitle,
				transaction.originalPayee,
				transaction.payee,
				counterpartAccount
					? `${counterpartAccount.account.title} (${counterpartAccount.company})`
					: undefined,
				transaction.mcc ? `mcc:${transaction.mcc}` : undefined,
			]);
			const currencyInstrument =
				selected.account.instrument ??
				(isIncome ? transaction.incomeInstrument : transaction.outcomeInstrument) ??
				transaction.incomeInstrument ??
				transaction.outcomeInstrument;
			const currency = currencyInstrument
				? instrumentsById.get(currencyInstrument) || selected.currency
				: selected.currency;
			const transactionType = transaction.hold
				? "hold"
				: counterpartAccount
					? "transfer"
					: direction;
			const reference = transaction.id || `${selected.account.id}:${transaction.date}:${amount}`;

			rows.push({
				date: transaction.date,
				amount,
				currency,
				partner,
				description,
				transactionType,
				reference,
				sourceFile: `zenmoney:${selected.account.id}:${reference}`,
				source: "zenmoney",
				accountId: selected.account.id,
				accountTitle: selected.account.title || selected.account.id,
				categoryId:
					transaction.tag != null
						? Array.isArray(transaction.tag)
							? transaction.tag.join(",")
							: String(transaction.tag)
						: null,
				categoryName:
					transaction.tag != null
						? Array.isArray(transaction.tag)
							? transaction.tag
									.map((t) => tagsById.get(String(t)) || String(t))
									.filter(Boolean)
									.join(" | ")
							: (tagsById.get(String(transaction.tag)) ?? null)
						: null,
			});
		}
	}

	return rows.sort((left, right) => {
		const dateCompare = left.date.localeCompare(right.date);
		if (dateCompare !== 0) return dateCompare;
		const accountCompare = left.accountTitle.localeCompare(right.accountTitle);
		if (accountCompare !== 0) return accountCompare;
		return left.reference.localeCompare(right.reference);
	});
}

function splitSelectors(input: string): string[] {
	return input
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function listSelectableAccounts(
	snapshot: ZenMoneySnapshot,
	query?: string,
	includeArchived = true,
): ResolvedAccount[] {
	const accounts = snapshot.accounts.map((account) => resolvedAccount(snapshot, account));
	const filtered = accounts.filter((entry) => includeArchived || !entry.account.archive);
	if (!query?.trim())
		return filtered.sort((left, right) =>
			(left.account.title || left.account.id).localeCompare(
				right.account.title || right.account.id,
			),
		);
	const selectors = splitSelectors(query);
	return filtered.filter((entry) =>
		selectors.some((selector) => accountMatchesSelector(entry, selector)),
	);
}

function resolveSelectedAccounts(
	snapshot: ZenMoneySnapshot,
	selectors: string[],
): ResolvedAccount[] {
	const trimmed = selectors.map((selector) => selector.trim()).filter(Boolean);
	if (trimmed.length === 0) throw new Error("At least one account selector is required.");

	const all = listSelectableAccounts(snapshot, undefined, true);
	const matches = all.filter((entry) =>
		trimmed.some((selector) => accountMatchesSelector(entry, selector)),
	);
	if (matches.length === 0) {
		throw new Error(
			`No ZenMoney accounts matched selectors: ${trimmed.join(", ")}. Use /zen-accounts to inspect available accounts.`,
		);
	}

	return matches;
}

function formatAccountsSummary(accounts: ResolvedAccount[], query?: string): string {
	const lines: string[] = [
		"# ZenMoney Accounts",
		"",
		`- Accounts matched: ${accounts.length}`,
		query?.trim() ? `- Query: \`${query}\`` : "- Query: all accounts",
		"",
		"| Title | Company | Type | Currency | Balance | Sync IDs | Account ID | Archived |",
		"|---|---|---|---|---:|---|---|---|",
	];

	accounts.forEach((entry) => {
		lines.push(
			`| ${(entry.account.title || "—").replace(/\|/g, " ")} | ${entry.company.replace(/\|/g, " ")} | ${entry.account.type || "—"} | ${entry.currency} | ${formatMoney(entry.account.balance ?? undefined, entry.currency)} | ${((entry.account.syncID || []).join(", ") || "—").replace(/\|/g, " ")} | \`${entry.account.id}\` | ${entry.account.archive ? "yes" : "no"} |`,
		);
	});

	lines.push(
		"",
		"Selectors can match account id, title substring, company substring, or syncID / last digits.",
	);
	return lines.join("\n");
}

function formatTransactionsCsv(rows: BankTransactionRow[]): string {
	return buildCsv(
		[
			"date",
			"amount",
			"currency",
			"account_title",
			"partner",
			"description",
			"transaction_type",
			"reference",
			"source_file",
			"category_id",
			"category_name",
		],
		rows.map((row) => [
			row.date,
			row.amount,
			row.currency,
			row.accountTitle,
			row.partner,
			row.description,
			row.transactionType,
			row.reference,
			row.sourceFile,
			row.categoryId ?? "",
			row.categoryName ?? "",
		]),
	);
}

function formatTransactionsSummary(
	rows: BankTransactionRow[],
	selectors: string[],
	period: string | undefined,
	accounts: ResolvedAccount[],
): string {
	const accountNames = [
		...new Set(accounts.map((entry) => entry.account.title || entry.account.id)),
	].sort();
	const totalsByCurrency = rows.reduce((map, row) => {
		const entry = map.get(row.currency) ?? { income: 0, outcome: 0, net: 0 };
		if (row.amount >= 0) entry.income += row.amount;
		else entry.outcome += Math.abs(row.amount);
		entry.net = entry.income - entry.outcome;
		map.set(row.currency, entry);
		return map;
	}, new Map<string, CurrencyTotals>());

	const lines: string[] = [
		"# ZenMoney Transactions",
		"",
		`- Source: ZenMoney API`,
		`- Account selectors: ${selectors.join(", ")}`,
		`- Accounts matched: ${accountNames.length}`,
		`- Transactions returned: ${rows.length}`,
		`- Period: ${period || "all available dates"}`,
		"",
	];

	if (totalsByCurrency.size > 0) {
		lines.push("## Totals by currency", "");
		[...totalsByCurrency.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.forEach(([currency, totals]) => {
				lines.push(
					`- ${currency}: income ${formatMoney(totals.income, currency)}, outcome ${formatMoney(totals.outcome, currency)}, net ${formatMoney(totals.net, currency)}`,
				);
			});
		lines.push("");
	}

	if (accountNames.length > 0) {
		lines.push("## Accounts", "");
		for (const name of accountNames) lines.push(`- ${name}`);
		lines.push("");
	}

	if (rows.length === 0) {
		lines.push("No transactions matched the selected accounts and period.");
		return lines.join("\n");
	}

	lines.push(
		"| Date | Amount | Account | Counterparty | Type | Reference |",
		"|---|---:|---|---|---|---|",
	);
	rows.slice(0, 40).forEach((row) => {
		lines.push(
			`| ${row.date} | ${formatMoney(row.amount, row.currency)} | ${row.accountTitle.replace(/\|/g, " ")} | ${(row.partner || row.description || "—").replace(/\|/g, " ")} | ${row.transactionType} | ${row.reference.replace(/\|/g, " ")} |`,
		);
	});
	if (rows.length > 40) lines.push(`| … | … | … | … | … | ${rows.length - 40} more transactions |`);
	return lines.join("\n");
}

function tokenizeZenMoneyArgs(raw: string): string[] {
	if (!raw.trim()) return [];
	const tokens: string[] = [];
	const regex = /"([^"]+)"|'([^']+)'|([^\s]+)/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec loop
	while ((match = regex.exec(raw)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3]);
	}
	return tokens;
}

function makeSelectorSlug(selectors: string[]): string {
	const normalized = selectors
		.map((selector) => normalizeText(selector))
		.join(" ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return normalized || "zenmoney-accounts";
}

function parsePersonalRegisterArgs(raw: string): {
	selectors: string[];
	period?: string;
	write: boolean;
} {
	const tokens = tokenizeZenMoneyArgs(raw)
		.map((token) => token.trim())
		.filter(Boolean);
	let write = false;
	const cleanTokens = tokens.filter((token) => {
		if (token === "--write") {
			write = true;
			return false;
		}
		return true;
	});

	const periodIndex = cleanTokens.findIndex((token) => /^\d{4}-\d{2}$/.test(token));
	const period = periodIndex >= 0 ? cleanTokens[periodIndex] : undefined;
	const selectorTokens =
		periodIndex >= 0
			? [...cleanTokens.slice(0, periodIndex), ...cleanTokens.slice(periodIndex + 1)]
			: cleanTokens;

	return {
		selectors: selectorTokens.length > 0 ? splitSelectors(selectorTokens.join(" ")) : [],
		period,
		write,
	};
}

function expectedPersonalRegisterPath(year: number): string {
	return join(
		"Personal",
		String(year),
		"Registers",
		`personal-zenmoney-transactions-${year}.jsonl`,
	);
}

function personalRegisterRowId(row: BankTransactionRow): string {
	return `zenmoney:${row.accountId}:${row.reference}`;
}

function formatRegisterAmount(value: number): string {
	return Number.isFinite(value) ? value.toFixed(2) : "";
}

function pathExistsEffect(path: string): Effect.Effect<boolean> {
	return Effect.map(
		Effect.either(
			Effect.tryPromise({
				try: () => fs.access(path),
				catch: (cause) => cause,
			}),
		),
		(result) => Either.isRight(result),
	);
}

async function pathExists(path: string): Promise<boolean> {
	return Effect.runPromise(pathExistsEffect(path));
}

function readJsonObjectEffect<T>(path: string): Effect.Effect<T | undefined> {
	return Effect.flatMap(
		Effect.either(
			Effect.tryPromise({
				try: () => fs.readFile(path, "utf8"),
				catch: (cause) => cause,
			}),
		),
		(result) => {
			if (Either.isLeft(result)) {
				const error = result.left as { code?: string };
				if (error.code === "ENOENT") return Effect.succeed(undefined);
				return Effect.fail(error instanceof Error ? error : new Error(String(error)));
			}

			return Effect.try({
				try: () => JSON.parse(result.right) as T,
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
		},
	);
}

async function readJsonObject<T>(path: string): Promise<T | undefined> {
	return Effect.runPromise(readJsonObjectEffect<T>(path));
}

async function readPersonalAccountPolicy(): Promise<PersonalAccountPolicy> {
	return (
		(await readJsonObject<PersonalAccountPolicy>(
			join("Personal", "ZenMoney", "personal-accounts.json"),
		)) ?? {}
	);
}

async function readPersonalClassificationRules(): Promise<PersonalClassificationRules> {
	return (
		(await readJsonObject<PersonalClassificationRules>(
			join("Personal", "ZenMoney", "classification-rules.json"),
		)) ?? {}
	);
}

function resolvePersonalSelectors(
	explicitSelectors: string[],
	policy: PersonalAccountPolicy,
): string[] {
	const selectors =
		explicitSelectors.length > 0 ? explicitSelectors : (policy.personal_selectors ?? []);
	if (selectors.length === 0) {
		throw new Error(
			"No personal ZenMoney selectors configured. Add Personal/ZenMoney/personal-accounts.json or pass explicit selectors.",
		);
	}

	const forbidden = new Set(
		(policy.forbidden_broad_selectors ?? []).map((selector) => normalizeText(selector)),
	);
	const excluded = new Set(
		(policy.excluded_business_selectors ?? []).map((selector) => normalizeText(selector)),
	);
	const errors: string[] = [];

	selectors.forEach((selector) => {
		const normalized = normalizeText(selector);
		if (forbidden.has(normalized))
			errors.push(`Selector \`${selector}\` is a forbidden broad selector.`);
		if (excluded.has(normalized))
			errors.push(
				`Selector \`${selector}\` is a business account selector and cannot be used for personal registers.`,
			);
	});

	if (errors.length > 0) throw new Error(errors.join("\n"));
	return selectors;
}

function readJsonlRecords(text: string): Array<Record<string, string>> {
	const rows: Array<Record<string, string>> = [];
	text.split(/\r?\n/).forEach((line, index) => {
		if (!line.trim()) return;
		const parsed = JSON.parse(line) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`line ${index + 1}: expected JSON object`);
		}

		const row: Record<string, string> = {};
		Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
			if (value === undefined || value === null) row[key] = "";
			else if (typeof value === "string") row[key] = value;
			else if (typeof value === "number" || typeof value === "boolean") row[key] = String(value);
			else row[key] = JSON.stringify(value);
		});
		rows.push(row);
	});
	return rows;
}

async function readPersonalRegisterRows(path: string): Promise<Array<Record<string, string>>> {
	if (!(await pathExists(path))) return [];
	return readJsonlRecords(await fs.readFile(path, "utf8"));
}

function orderPersonalRegisterRow(row: Record<string, string>): Record<string, string> {
	const ordered: Record<string, string> = {};
	PERSONAL_REGISTER_COLUMNS.forEach((column) => {
		if (row[column] !== undefined) ordered[column] = row[column];
	});
	Object.keys(row)
		.filter((key) => !(PERSONAL_REGISTER_COLUMNS as readonly string[]).includes(key))
		.sort()
		.forEach((key) => {
			ordered[key] = row[key];
		});
	return ordered;
}

function sortPersonalRegisterRows(
	left: Record<string, string>,
	right: Record<string, string>,
): number {
	const dateCompare = (left.date || "").localeCompare(right.date || "");
	if (dateCompare !== 0) return dateCompare;
	const accountCompare = (left.account_title || "").localeCompare(right.account_title || "");
	if (accountCompare !== 0) return accountCompare;
	return (left.id || "").localeCompare(right.id || "");
}

async function writePersonalRegisterRows(
	path: string,
	rows: Array<Record<string, string>>,
): Promise<void> {
	await fs.mkdir(
		join("Personal", String(path.match(/(\d{4})/)?.[1] ?? new Date().getFullYear()), "Registers"),
		{ recursive: true },
	);
	const content = rows.map((row) => JSON.stringify(orderPersonalRegisterRow(row))).join("\n");
	await fs.writeFile(path, `${content}${content ? "\n" : ""}`, "utf8");
}

function buildLinkedTransferMap(rows: BankTransactionRow[]): Map<string, string> {
	const byReference = new Map<string, BankTransactionRow[]>();
	rows.forEach((row) => {
		const group = byReference.get(row.reference) ?? [];
		group.push(row);
		byReference.set(row.reference, group);
	});

	const linked = new Map<string, string>();
	byReference.forEach((group) => {
		if (group.length < 2) return;
		const hasIncome = group.some((row) => row.amount > 0);
		const hasOutcome = group.some((row) => row.amount < 0);
		if (!hasIncome || !hasOutcome) return;

		group.forEach((row) => {
			const id = personalRegisterRowId(row);
			linked.set(
				id,
				group
					.filter((candidate) => candidate !== row)
					.map((candidate) => personalRegisterRowId(candidate))
					.join(";"),
			);
		});
	});
	return linked;
}

function rowText(row: BankTransactionRow): string {
	return [row.partner, row.description, row.categoryName ?? ""].filter(Boolean).join(" | ");
}

function boundaryEntityFromText(text: string, category?: string): string {
	const normalized = normalizeText(`${text} ${category ?? ""}`);
	if (normalized.includes("fluxomnia") || normalized.includes("1193")) return "Fluxomnia";
	if (normalized.includes("zivnost") || normalized.includes("2119")) return "Zivnost";
	return "";
}

function rowMatchesReviewOnlyAccount(
	row: BankTransactionRow,
	policy: PersonalAccountPolicy,
): boolean {
	const normalizedPartner = normalizeText(row.partner);
	return (policy.review_only_selectors ?? []).some((selector) =>
		normalizedPartner.includes(normalizeText(selector)),
	);
}

function classifyPersonalRegisterRow(
	row: BankTransactionRow,
	linkedTransferId: string | undefined,
	policy: PersonalAccountPolicy,
	rules: PersonalClassificationRules,
	warnings: string[],
): Pick<
	Record<string, string>,
	| "cashflow_bucket"
	| "cashflow_category"
	| "boundary_entity"
	| "review_status"
	| "classification_source"
	| "notes"
> {
	const text = rowText(row);
	if (linkedTransferId) {
		return {
			cashflow_bucket: "internal_transfer",
			cashflow_category: "own_account_transfer",
			boundary_entity: "",
			review_status: "excluded",
			classification_source: "transfer_pair",
			notes: "Paired ZenMoney rows across selected personal accounts.",
		};
	}

	if (rowMatchesReviewOnlyAccount(row, policy)) {
		return {
			cashflow_bucket: "manual_review",
			cashflow_category: "review_only_account_transfer",
			boundary_entity: "",
			review_status: "needs_review",
			classification_source: "account_policy",
			notes: "Counterparty matches a review-only account selector.",
		};
	}

	if (
		normalizeText(text).includes("to investment account") ||
		normalizeText(row.categoryName ?? "") === "investment"
	) {
		return {
			cashflow_bucket: "internal_transfer",
			cashflow_category: "savings_investment",
			boundary_entity: "",
			review_status: "excluded",
			classification_source: "zenmoney_category",
			notes: "Savings/investment movement outside real spending.",
		};
	}

	for (const rule of rules.rules ?? []) {
		if (!rule.match) continue;
		const patternResult = Effect.runSync(
			Effect.either(
				Effect.try({
					try: () => new RegExp(rule.match, "i"),
					catch: (error) => error,
				}),
			),
		);
		if (Either.isLeft(patternResult)) {
			const error = patternResult.left;
			warnings.push(
				`Skipped invalid personal classification rule \`${rule.match}\`: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		const pattern = patternResult.right;

		if (!pattern.test(text)) continue;
		const bucket = rule.bucket || (row.amount >= 0 ? "real_income" : "real_expense");
		if (row.amount > 0 && bucket === "real_expense") continue;
		return {
			cashflow_bucket: bucket,
			cashflow_category:
				rule.category || row.categoryName || (row.amount >= 0 ? "other_income" : "other_personal"),
			boundary_entity:
				bucket === "business_boundary" ? boundaryEntityFromText(text, rule.category) : "",
			review_status:
				rule.requires_review || bucket === "manual_review" || bucket === "business_boundary"
					? "needs_review"
					: "auto_classified",
			classification_source: "classification_rules",
			notes: rule.note ?? "",
		};
	}

	const categoryName = row.categoryName?.trim() || "";
	const normalizedCategory = normalizeText(categoryName);
	const refundLike =
		row.amount > 0 &&
		(normalizedCategory.includes("refund") ||
			normalizedCategory.includes("vozvrat") ||
			normalizedCategory.includes("возврат"));
	return {
		cashflow_bucket: row.amount >= 0 ? "real_income" : "real_expense",
		cashflow_category: refundLike
			? "refund"
			: categoryName || (row.amount >= 0 ? "other_income" : "other_personal"),
		boundary_entity: "",
		review_status: "auto_classified",
		classification_source: categoryName ? "zenmoney_category" : "amount_default",
		notes:
			row.amount > 0
				? "Positive external row; monthly reports should confirm whether this is income or a refund/reversal."
				: "",
	};
}

function buildPersonalRegisterRows(
	rows: BankTransactionRow[],
	accounts: ResolvedAccount[],
	policy: PersonalAccountPolicy,
	rules: PersonalClassificationRules,
	warnings: string[],
): Array<Record<string, string>> {
	const accountCompanyById = new Map(accounts.map((entry) => [entry.account.id, entry.company]));
	const linkedTransfers = buildLinkedTransferMap(rows);

	return rows.map((row) => {
		const id = personalRegisterRowId(row);
		const linkedTransferId = linkedTransfers.get(id);
		const classification = classifyPersonalRegisterRow(
			row,
			linkedTransferId,
			policy,
			rules,
			warnings,
		);
		return {
			id,
			period: row.date.slice(0, 7),
			date: row.date,
			account_id: row.accountId,
			account_title: row.accountTitle,
			account_company: accountCompanyById.get(row.accountId) ?? "",
			currency: row.currency,
			amount: formatRegisterAmount(row.amount),
			direction: row.amount >= 0 ? "income" : "outcome",
			counterparty: row.partner,
			description: row.description,
			transaction_type: row.transactionType,
			reference: row.reference,
			source: row.source,
			source_file: row.sourceFile,
			category_id: row.categoryId ?? "",
			category_name: row.categoryName ?? "",
			...classification,
			linked_transfer_id: linkedTransferId ?? "",
			evidence_file: "",
		};
	});
}

function mergePersonalRegisterRows(
	existingRows: Array<Record<string, string>>,
	generatedRows: Array<Record<string, string>>,
): { rows: Array<Record<string, string>>; newRows: number; updatedRows: number } {
	const byId = new Map(existingRows.map((row) => [row.id, row]));
	let newRows = 0;
	let updatedRows = 0;

	generatedRows.forEach((generated) => {
		const existing = byId.get(generated.id);
		if (!existing) {
			byId.set(generated.id, generated);
			newRows += 1;
			return;
		}

		const merged = { ...existing, ...generated };
		PERSONAL_REGISTER_PRESERVED_FIELDS.forEach((field) => {
			if (existing[field]) merged[field] = existing[field];
		});

		if (
			JSON.stringify(orderPersonalRegisterRow(existing)) !==
			JSON.stringify(orderPersonalRegisterRow(merged))
		) {
			updatedRows += 1;
		}
		byId.set(generated.id, merged);
	});

	return { rows: [...byId.values()].sort(sortPersonalRegisterRows), newRows, updatedRows };
}

function formatPersonalRegisterSummary(
	result: Omit<PersonalRegisterResult, "summary">,
	periodRows: Array<Record<string, string>>,
	selectors: string[],
): string {
	const bucketTotals = periodRows.reduce((map, row) => {
		const bucket = row.cashflow_bucket || "unclassified";
		const currency = row.currency || "";
		const key = `${bucket}|${currency}`;
		const amount = Number.parseFloat(row.amount || "0") || 0;
		const totals = map.get(key) ?? { bucket, currency, rows: 0, income: 0, outcome: 0, net: 0 };
		totals.rows += 1;
		if (amount >= 0) totals.income += amount;
		else totals.outcome += Math.abs(amount);
		totals.net = totals.income - totals.outcome;
		map.set(key, totals);
		return map;
	}, new Map<
		string,
		{ bucket: string; currency: string; rows: number; income: number; outcome: number; net: number }
	>());

	const lines: string[] = [
		`# Personal ZenMoney Register — ${result.period}`,
		"",
		`- Mode: ${result.dryRun ? "dry run (no files written)" : "written"}`,
		`- Register path: \`${result.registerPath}\``,
		`- Register file: \`${basename(result.registerPath)}\``,
		`- Source: ZenMoney API`,
		`- Account selectors: ${selectors.join(", ")}`,
		`- Fetched rows for period: ${result.fetchedRows}`,
		`- Existing rows before merge: ${result.existingRows}`,
		`- New rows: ${result.newRows}`,
		`- Updated rows: ${result.updatedRows}`,
		`- Total rows after merge: ${result.totalRows}`,
		"",
		"## Cashflow bucket totals for fetched period",
		"",
	];

	if (bucketTotals.size === 0) {
		lines.push("No rows found for this period.", "");
	} else {
		lines.push(
			"| Bucket | Currency | Rows | Income | Outcome | Net |",
			"|---|---|---:|---:|---:|---:|",
		);
		[...bucketTotals.values()]
			.sort((left, right) =>
				`${left.bucket}|${left.currency}`.localeCompare(`${right.bucket}|${right.currency}`),
			)
			.forEach((totals) => {
				lines.push(
					`| ${totals.bucket} | ${totals.currency || "—"} | ${totals.rows} | ${formatMoney(totals.income, totals.currency)} | ${formatMoney(totals.outcome, totals.currency)} | ${formatMoney(totals.net, totals.currency)} |`,
				);
			});
		lines.push("");
	}

	const reviewRows = periodRows.filter((row) => row.review_status === "needs_review");
	if (reviewRows.length > 0) {
		lines.push(
			"## Review rows",
			"",
			"| Date | Amount | Account | Counterparty | Bucket |",
			"|---|---:|---|---|---|",
		);
		reviewRows.slice(0, 20).forEach((row) => {
			lines.push(
				`| ${row.date} | ${formatMoney(Number.parseFloat(row.amount), row.currency)} | ${row.account_title.replace(/\|/g, " ")} | ${(row.counterparty || row.description || "—").replace(/\|/g, " ")} | ${row.cashflow_bucket} |`,
			);
		});
		if (reviewRows.length > 20)
			lines.push(`| … | … | … | … | ${reviewRows.length - 20} more rows |`);
		lines.push("");
	}

	if (result.warnings.length > 0) {
		lines.push("## Warnings", "");
		for (const warning of [...new Set(result.warnings)]) lines.push(`- ${warning}`);
		lines.push("");
	}

	lines.push(
		"Generated rows keep one ZenMoney account-side transaction per JSONL line. Reports should read this register as the canonical transaction base and use CSV snapshots only as reproducible extracts.",
	);
	return lines.join("\n");
}

// @lat: [[personal-finances#Personal Finances#ZenMoney Personal Transaction Register]]
async function preparePersonalTransactionRegister(params: {
	period: string;
	selectors?: string[];
	write?: boolean;
}): Promise<PersonalRegisterResult> {
	const period = parseMonthPeriod(params.period);
	if (!period) throw new Error(`Invalid period \`${params.period}\`. Expected format: YYYY-MM.`);

	const year = Number.parseInt(period.slice(0, 4), 10);
	const policy = await readPersonalAccountPolicy();
	const rules = await readPersonalClassificationRules();
	const selectors = resolvePersonalSelectors(params.selectors ?? [], policy);
	const registerPath = expectedPersonalRegisterPath(year);
	const warnings: string[] = [];

	const source = await readZenMoneyTransactions(selectors, period);
	const generatedRows = buildPersonalRegisterRows(
		source.transactions,
		source.accounts,
		policy,
		rules,
		warnings,
	);
	const existingRows = await readPersonalRegisterRows(registerPath);
	const merged = mergePersonalRegisterRows(existingRows, generatedRows);

	if (params.write) await writePersonalRegisterRows(registerPath, merged.rows);

	const resultWithoutSummary: Omit<PersonalRegisterResult, "summary"> = {
		period,
		registerPath,
		dryRun: !params.write,
		fetchedRows: generatedRows.length,
		existingRows: existingRows.length,
		newRows: merged.newRows,
		updatedRows: merged.updatedRows,
		totalRows: merged.rows.length,
		warnings,
	};

	return {
		...resultWithoutSummary,
		summary: formatPersonalRegisterSummary(resultWithoutSummary, generatedRows, selectors),
	};
}

function parsePersonalBalanceArgs(raw: string): {
	selectors: string[];
	period?: string;
	store: boolean;
} {
	const tokens = tokenizeZenMoneyArgs(raw)
		.map((token) => token.trim())
		.filter(Boolean);
	let store = false;
	const cleanTokens = tokens.filter((token) => {
		if (token === "--store") return false;
		if (token === "--save") {
			store = true;
			return false;
		}
		return true;
	});

	if (cleanTokens.length === 0) {
		const envSelectors = process.env.ZENMONEY_PERSONAL_SELECTORS?.trim();
		if (envSelectors) {
			return {
				selectors: splitSelectors(envSelectors),
				period: undefined,
				store,
			};
		}
		return { selectors: [], period: undefined, store };
	}

	let period: string | undefined;
	const last = cleanTokens.at(-1);
	if (last && /^\d{4}-\d{2}$/.test(last)) {
		period = last;
		cleanTokens.pop();
	}

	const selectorText = cleanTokens.join(" ").trim();
	if (!selectorText) {
		const envSelectors = process.env.ZENMONEY_PERSONAL_SELECTORS?.trim();
		if (envSelectors) {
			return {
				selectors: splitSelectors(envSelectors),
				period,
				store,
			};
		}
		return { selectors: [], period, store };
	}

	return {
		selectors: splitSelectors(selectorText),
		period,
		store,
	};
}

function buildPersonalBalanceSummary(
	rows: BankTransactionRow[],
	selectors: string[],
	period: string | undefined,
	accounts: ResolvedAccount[],
	balances: Map<string, number>,
): string {
	const transactionSummary = formatTransactionsSummary(rows, selectors, period, accounts);
	const lines: string[] = [
		"# ZenMoney Personal Balance",
		"",
		`- Source: ZenMoney API`,
		`- Account selectors: ${selectors.join(", ")}`,
		`- Accounts matched: ${accounts.length}`,
		`- Transactions returned: ${rows.length}`,
		`- Period: ${period || "all available dates"}`,
		"",
		"## Current balances by currency",
	];

	if (balances.size > 0) {
		[...balances.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.forEach(([currency, balance]) => {
				lines.push(`- ${currency}: ${formatMoney(balance, currency)}`);
			});
	} else {
		lines.push("- No balance data available for selected accounts.");
	}

	lines.push("", "## Account balances", "");
	if (accounts.length === 0) {
		lines.push("No accounts matched.");
	} else {
		lines.push(
			"| Account | Currency | Balance | Sync IDs | Company | Archived |",
			"|---|---|---:|---|---|---|",
		);
		accounts.forEach((entry) => {
			lines.push(
				`| ${(entry.account.title || "—").replace(/\|/g, " ")} | ${entry.currency} | ${formatMoney(entry.account.balance ?? undefined, entry.currency)} | ${((entry.account.syncID || []).join(", ") || "—").replace(/\|/g, " ")} | ${entry.company.replace(/\|/g, " ")} | ${entry.account.archive ? "yes" : "no"} |`,
			);
		});
	}

	lines.push("", "## Transactions", "");
	lines.push(transactionSummary);
	return lines.join("\n");
}

async function readZenMoneyTransactions(
	selectors: string[],
	period?: string,
): Promise<{
	summary: string;
	csv: string;
	transactions: BankTransactionRow[];
	accounts: ResolvedAccount[];
	tags: Map<string, string>;
}> {
	const normalizedPeriod = parseMonthPeriod(period);
	if (period && !normalizedPeriod) {
		throw new Error(`Invalid period \`${period}\`. Expected format: YYYY-MM.`);
	}

	const snapshot = await fetchZenMoneySnapshot();
	const accounts = resolveSelectedAccounts(snapshot, selectors);
	let rows = normalizeTransactionRows(snapshot, accounts);
	if (normalizedPeriod) rows = rows.filter((row) => row.date.startsWith(normalizedPeriod));

	const tags = new Map(
		(snapshot.tags ?? []).map((tag) => [String(tag.id), tag.title || String(tag.id)]),
	);

	return {
		summary: formatTransactionsSummary(rows, selectors, normalizedPeriod, accounts),
		csv: formatTransactionsCsv(rows),
		transactions: rows,
		accounts,
		tags,
	};
}

async function readPersonalBalanceSnapshot(params: {
	selectors: string[];
	period?: string;
}): Promise<{
	summary: string;
	csv: string;
	transactions: BankTransactionRow[];
	accounts: ResolvedAccount[];
	balancesByCurrency: Array<{ currency: string; balance: number }>;
	totalsByCurrency: Array<{ currency: string; income: number; outcome: number; net: number }>;
	transactionCount: number;
	tags: Map<string, string>;
}> {
	const result = await readZenMoneyTransactions(params.selectors, params.period);
	const balancesByCurrencyMap = result.accounts.reduce((map, entry) => {
		const value = entry.account.balance;
		if (value === undefined || value === null || Number.isNaN(value)) return map;
		map.set(entry.currency, (map.get(entry.currency) ?? 0) + value);
		return map;
	}, new Map<string, number>());

	const totalsByCurrencyMap = result.transactions.reduce((map, row) => {
		const totals = map.get(row.currency) ?? { income: 0, outcome: 0, net: 0 };
		if (row.amount >= 0) totals.income += row.amount;
		else totals.outcome += Math.abs(row.amount);
		totals.net = totals.income - totals.outcome;
		map.set(row.currency, totals);
		return map;
	}, new Map<string, CurrencyTotals>());

	const summary = buildPersonalBalanceSummary(
		result.transactions,
		params.selectors,
		params.period,
		result.accounts,
		balancesByCurrencyMap,
	);

	return {
		summary,
		csv: result.csv,
		transactions: result.transactions,
		accounts: result.accounts,
		balancesByCurrency: [...balancesByCurrencyMap.entries()].map(([currency, balance]) => ({
			currency,
			balance,
		})),
		totalsByCurrency: [...totalsByCurrencyMap.entries()].map(([currency, totals]) => ({
			currency,
			...totals,
		})),
		transactionCount: result.transactions.length,
		tags: result.tags,
	};
}

async function storePersonalBalanceSnapshot(params: {
	selectors: string[];
	period?: string;
	summary: string;
	csv: string;
	accounts: ResolvedAccount[];
	balancesByCurrency: Array<{ currency: string; balance: number }>;
	totalsByCurrency: Array<{ currency: string; income: number; outcome: number; net: number }>;
	transactionCount: number;
	tags?: Map<string, string>;
}): Promise<{ jsonPath: string; csvPath: string }> {
	const selectorSlug = makeSelectorSlug(params.selectors);
	const periodPart = params.period || "all";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filePrefix = `${selectorSlug}-${periodPart}-${timestamp}`;

	const baseDir = join("Personal", "ZenMoney", "snapshots");
	await fs.mkdir(baseDir, { recursive: true });

	const jsonPath = join(baseDir, `${filePrefix}.json`);
	const csvPath = join(baseDir, `${filePrefix}.csv`);

	const payload = {
		generatedAt: new Date().toISOString(),
		selectors: params.selectors,
		period: params.period,
		accountCount: params.accounts.length,
		balancesByCurrency: params.balancesByCurrency,
		totalsByCurrency: params.totalsByCurrency,
		accounts: params.accounts.map((entry) => ({
			id: entry.account.id,
			title: entry.account.title,
			company: entry.company,
			currency: entry.currency,
			balance: entry.account.balance,
			archived: Boolean(entry.account.archive),
			syncID: entry.account.syncID,
		})),
		source: "zenmoney",
		transactions: params.transactionCount,
		tags: params.tags ? Object.fromEntries(params.tags) : undefined,
		summary: params.summary,
	};

	await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	await fs.writeFile(csvPath, params.csv, "utf8");

	return { jsonPath, csvPath };
}

async function listZenMoneyAccounts(
	query?: string,
	includeArchived = true,
): Promise<{ summary: string; accounts: ResolvedAccount[] }> {
	const snapshot = await fetchZenMoneySnapshot();
	const accounts = listSelectableAccounts(snapshot, query, includeArchived);
	return { summary: formatAccountsSummary(accounts, query), accounts };
}

async function sendZenMoneyReport(pi: ExtensionAPI, title: string, body: string) {
	pi.sendMessage({
		customType: "zenmoney-report",
		content: `${title}\n\n${body}`,
		display: true,
	});
}

// @lat: [[automation#Accounting Automation#Extension#ZenMoney Live Bank Data]]
export default function registerZenMoneyExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(
		"zenmoney-report",
		(message: { content: string }, { expanded }: { expanded: boolean }, theme: Theme) =>
			renderPreview(message.content, expanded, theme),
	);

	pi.registerCommand("zen-accounts", {
		description: "List ZenMoney accounts available for explicit selection",
		handler: async (args: string, ctx: CommandContext) =>
			runZenMoneyBoundary(
				ctx,
				Effect.gen(function* () {
					const query = args.trim() || undefined;
					const result = yield* effectFromZenMoneyPromise(() => listZenMoneyAccounts(query, true));
					yield* Effect.sync(() => {
						sendZenMoneyReport(
							pi,
							query ? `ZenMoney accounts matching ${query}` : "ZenMoney accounts",
							result.summary,
						);
					});
				}),
			),
	});

	pi.registerCommand("zen-transactions", {
		description: "Read ZenMoney transactions for explicitly selected accounts",
		handler: async (args: string, ctx: CommandContext) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("Usage: /zen-transactions <selector[,selector...]> [YYYY-MM]", "error");
				return;
			}

			const parts = raw.split(/\s+/).filter(Boolean);
			const last = parts.at(-1);
			const period = last && /^\d{4}-\d{2}$/.test(last) ? last : undefined;
			const selectorText = period ? raw.slice(0, raw.lastIndexOf(period)).trim() : raw;
			const selectors = splitSelectors(selectorText);
			if (selectors.length === 0) {
				ctx.ui.notify("Usage: /zen-transactions <selector[,selector...]> [YYYY-MM]", "error");
				return;
			}

			await runZenMoneyBoundary(
				ctx,
				Effect.gen(function* () {
					const result = yield* effectFromZenMoneyPromise(() =>
						readZenMoneyTransactions(selectors, period),
					);
					yield* Effect.sync(() => {
						sendZenMoneyReport(
							pi,
							`ZenMoney transactions ${selectors.join(", ")}${period ? ` ${period}` : ""}`,
							result.summary,
						);
					});
				}),
			);
		},
	});

	pi.registerCommand("zen-personal-balance", {
		description: "Summarize ZenMoney balances and monthly totals for personal accounts",
		handler: async (args: string, ctx: CommandContext) => {
			const parsed = parsePersonalBalanceArgs(args);
			if (parsed.selectors.length === 0) {
				ctx.ui.notify(
					"Usage: /zen-personal-balance <selector[,selector...]> [YYYY-MM] [--store].\nIf selectors are omitted, set ZENMONEY_PERSONAL_SELECTORS.",
					"error",
				);
				return;
			}

			await runZenMoneyBoundary(
				ctx,
				Effect.gen(function* () {
					const result = yield* effectFromZenMoneyPromise(() =>
						readPersonalBalanceSnapshot({
							selectors: parsed.selectors,
							period: parsed.period,
						}),
					);

					let summary = result.summary;
					if (parsed.store) {
						const saved = yield* effectFromZenMoneyPromise(() =>
							storePersonalBalanceSnapshot({
								selectors: parsed.selectors,
								period: parsed.period,
								summary: result.summary,
								csv: result.csv,
								accounts: result.accounts,
								balancesByCurrency: result.balancesByCurrency,
								totalsByCurrency: result.totalsByCurrency,
								transactionCount: result.transactionCount,
								tags: result.tags,
							}),
						);
						summary += `\n\nSaved local base snapshot to:\n- ${saved.jsonPath}\n- ${saved.csvPath}`;
					}

					yield* Effect.sync(() => {
						sendZenMoneyReport(
							pi,
							`ZenMoney personal balance ${parsed.selectors.join(",")} ${parsed.period ?? "all"}`,
							summary,
						);
					});
				}),
			);
		},
	});

	pi.registerCommand("zen-personal-register", {
		description: "Preview or write the canonical personal ZenMoney transaction JSONL register",
		handler: async (args: string, ctx: CommandContext) => {
			const parsed = parsePersonalRegisterArgs(args);
			if (!parsed.period) {
				ctx.ui.notify(
					"Usage: /zen-personal-register <YYYY-MM> [--write] [selector[,selector...]].\nIf selectors are omitted, Personal/ZenMoney/personal-accounts.json is used.",
					"error",
				);
				return;
			}

			const period = parsed.period;
			await runZenMoneyBoundary(
				ctx,
				Effect.gen(function* () {
					const result = yield* effectFromZenMoneyPromise(() =>
						preparePersonalTransactionRegister({
							period,
							selectors: parsed.selectors.length > 0 ? parsed.selectors : undefined,
							write: parsed.write,
						}),
					);
					yield* Effect.sync(() => {
						sendZenMoneyReport(pi, `ZenMoney personal register ${period}`, result.summary);
					});
				}),
			);
		},
	});

	pi.registerTool({
		name: "zenmoney_list_accounts",
		label: "ZenMoney List Accounts",
		description:
			"List ZenMoney accounts so personal and business accounts can be selected explicitly",
		promptSnippet:
			"List available ZenMoney accounts before selecting which ones belong to a business workflow",
		promptGuidelines: [
			"Use this tool before fetching transactions from ZenMoney when the profile mixes personal and business accounts.",
			"Selectors can match account id, title substring, company substring, or syncID / last digits.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Optional filter text to narrow matching accounts" }),
			),
			includeArchived: Type.Optional(
				Type.Boolean({ description: "If true, include archived accounts" }),
			),
		}),
		async execute(_id: string, params: { query?: string; includeArchived?: boolean }) {
			const result = await listZenMoneyAccounts(params.query, params.includeArchived ?? true);
			return {
				content: [{ type: "text", text: trimText(result.summary, 120, 12000) }],
				details: {
					count: result.accounts.length,
					accounts: result.accounts.map((entry) => ({
						id: entry.account.id,
						title: entry.account.title,
						company: entry.company,
						type: entry.account.type,
						currency: entry.currency,
						syncID: entry.account.syncID ?? [],
						archived: Boolean(entry.account.archive),
						balance: entry.account.balance,
					})),
				},
			};
		},
		renderCall(args: { query?: string; includeArchived?: boolean }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("zenmoney_list_accounts "))}${theme.fg("dim", `${args.query ?? "all"}${args.includeArchived === false ? " active-only" : ""}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "zenmoney_personal_balance",
		label: "ZenMoney Personal Balance",
		description: "Summarize personal ZenMoney account balances and transaction totals",
		promptSnippet:
			"Summarize personal account balances and monthly spend/income before personal budgeting",
		promptGuidelines: [
			"Use explicit selectors to avoid mixing business and personal accounts.",
			"Pass selectors that match account id, title substring, company substring, or syncID / last digits.",
			"Use period to narrow results to one month, for example 2026-03.",
			"Enable store=true to persist JSON and CSV snapshot under Personal/ZenMoney/snapshots.",
		],
		parameters: Type.Object({
			selectors: Type.Array(
				Type.String({ description: "Account selectors such as titles, ids, or last digits" }),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-03" })),
			store: Type.Optional(
				Type.Boolean({ description: "Persist a local Personal/ZenMoney snapshot (JSON + CSV)" }),
			),
		}),
		async execute(
			_id: string,
			params: {
				selectors: string[];
				period?: string;
				store?: boolean;
			},
		) {
			const result = await readPersonalBalanceSnapshot({
				selectors: params.selectors,
				period: params.period,
			});

			let saved: { jsonPath: string; csvPath: string } | undefined;
			if (params.store) {
				saved = await storePersonalBalanceSnapshot({
					selectors: params.selectors,
					period: params.period,
					summary: result.summary,
					csv: result.csv,
					accounts: result.accounts,
					balancesByCurrency: result.balancesByCurrency,
					totalsByCurrency: result.totalsByCurrency,
					transactionCount: result.transactionCount,
					tags: result.tags,
				});
			}

			return {
				content: [{ type: "text", text: trimText(result.summary, 120, 12000) }],
				details: {
					count: result.transactionCount,
					period: params.period || "all",
					accounts: result.accounts.map((entry) => ({
						id: entry.account.id,
						title: entry.account.title,
						company: entry.company,
						currency: entry.currency,
						balance: entry.account.balance,
						archived: Boolean(entry.account.archive),
					})),
					balancesByCurrency: result.balancesByCurrency,
					totalsByCurrency: result.totalsByCurrency,
					csv: result.csv,
					snapshot: saved
						? {
								json: saved.jsonPath,
								csv: saved.csvPath,
							}
						: undefined,
				},
			};
		},
		renderCall(args: { selectors: string[]; period?: string; store?: boolean }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("zenmoney_personal_balance "))}${theme.fg("dim", `${args.selectors.join(",")} ${args.period || "all"}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "zenmoney_personal_register",
		label: "ZenMoney Personal Register",
		description: "Create or preview a canonical personal ZenMoney transaction JSONL register",
		promptSnippet:
			"Store personal ZenMoney transactions as one JSONL row per account-side transaction before monthly reporting",
		promptGuidelines: [
			"Use this tool when personal reports should use the same JSONL source-of-truth pattern as business registers.",
			"Use period to narrow the import to one month, for example 2026-03.",
			"Omit selectors to use Personal/ZenMoney/personal-accounts.json; pass selectors only when the user explicitly wants a different safe scope.",
			"Set write=true only after reviewing the dry-run summary.",
		],
		parameters: Type.Object({
			period: Type.String({ description: "Month to import, such as 2026-03" }),
			selectors: Type.Optional(
				Type.Array(Type.String({ description: "Optional explicit account selectors" })),
			),
			write: Type.Optional(
				Type.Boolean({ description: "If true, write or update the JSONL register" }),
			),
		}),
		async execute(_id: string, params: { period: string; selectors?: string[]; write?: boolean }) {
			const result = await preparePersonalTransactionRegister({
				period: params.period,
				selectors: params.selectors,
				write: params.write,
			});
			return {
				content: [{ type: "text", text: trimText(result.summary, 120, 12000) }],
				details: {
					period: result.period,
					registerPath: result.registerPath,
					dryRun: result.dryRun,
					fetchedRows: result.fetchedRows,
					existingRows: result.existingRows,
					newRows: result.newRows,
					updatedRows: result.updatedRows,
					totalRows: result.totalRows,
					warnings: result.warnings,
				},
			};
		},
		renderCall(args: { period: string; selectors?: string[]; write?: boolean }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("zenmoney_personal_register "))}${theme.fg("dim", `${args.period}${args.write ? " --write" : ""}${args.selectors?.length ? ` ${args.selectors.join(",")}` : " policy"}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "zenmoney_read_transactions",
		label: "ZenMoney Read Transactions",
		description: "Fetch normalized ZenMoney transactions for explicitly selected accounts",
		promptSnippet: "Fetch actual bank data from ZenMoney for explicitly selected accounts",
		promptGuidelines: [
			"Use zenmoney_list_accounts first when the ZenMoney profile mixes personal and business accounts.",
			"Pass selectors that match account id, title substring, company substring, or syncID / last digits.",
			"Use period to narrow results to one month, for example 2026-03.",
		],
		parameters: Type.Object({
			selectors: Type.Array(
				Type.String({ description: "Account selectors such as titles, ids, or last digits" }),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-03" })),
		}),
		async execute(_id: string, params: { selectors: string[]; period?: string }) {
			const result = await readZenMoneyTransactions(params.selectors, params.period);
			return {
				content: [{ type: "text", text: trimText(result.summary, 120, 12000) }],
				details: {
					count: result.transactions.length,
					accounts: result.accounts.map((entry) => ({
						id: entry.account.id,
						title: entry.account.title,
						company: entry.company,
						currency: entry.currency,
					})),
					transactions: result.transactions.slice(0, 200),
					csv: result.csv,
				},
			};
		},
		renderCall(args: { selectors: string[]; period?: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("zenmoney_read_transactions "))}${theme.fg("dim", `${args.selectors.join(",")}${args.period ? ` ${args.period}` : ""}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});
}
