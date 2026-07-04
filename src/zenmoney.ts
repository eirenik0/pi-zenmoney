import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Data, Effect } from "effect";
import { Type } from "typebox";

import { PREVIEW_LINES } from "./constants.ts";
import { ZenMoneyHubEditor, type ZenMoneyHubResult } from "./hub.ts";
import { resolveSecretReference } from "./secret-refs.ts";
import type {
	BankTransactionRow,
	CurrencyTotals,
	ResolvedAccount,
	ZenMoneyAccount,
	ZenMoneyCategory,
	ZenMoneyCompany,
	ZenMoneyEntityPolicy,
	ZenMoneyInstrument,
	ZenMoneyMerchant,
	ZenMoneySnapshot,
	ZenMoneyTransaction,
} from "./types.ts";
import {
	deleteZenMoneyEntity,
	listZenMoneyEntities,
	normalizeZenMoneyEntity,
	normalizeZenMoneySnapshotPath,
	readZenMoneyEntityPolicy,
	readZenMoneyWorkspaceConfig,
	writeZenMoneyEntityPolicy,
	writeZenMoneyRegistry,
	writeZenMoneyWorkspaceConfig,
	zenMoneyEntityPolicyPath,
	zenMoneyEntitySnapshotsDir,
} from "./workspace.ts";

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

interface ZenMoneyWorkingProfile {
	entity: string;
	policy: ZenMoneyEntityPolicy;
	policyPath: string;
}

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

function makeSelectorSlug(selectors: string[]): string {
	const normalized = selectors
		.map((selector) => normalizeText(selector))
		.join(" ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return normalized || "zenmoney-accounts";
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
		"Then use `/zenmoney` to open the hub and discover selectable accounts by id, title, or syncID.",
		"",
		"The extension focuses on ZenMoney account discovery and transaction export.",
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

function isZenMoneyTransfer(transaction: ZenMoneyTransaction): boolean {
	return (transaction.income ?? 0) > 0 && (transaction.outcome ?? 0) > 0;
}

function summarizeClearSpending(
	rows: BankTransactionRow[],
): Map<string, { count: number; amount: number }> {
	return rows.reduce((map, row) => {
		if (row.transactionType !== "outcome" || row.amount >= 0) return map;
		const entry = map.get(row.currency) ?? { count: 0, amount: 0 };
		entry.count += 1;
		entry.amount += Math.abs(row.amount);
		map.set(row.currency, entry);
		return map;
	}, new Map<string, { count: number; amount: number }>());
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
				: isZenMoneyTransfer(transaction)
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
			`No ZenMoney accounts matched selectors: ${trimmed.join(", ")}. Use /zenmoney to inspect available accounts.`,
		);
	}

	return matches;
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
	const clearSpendingByCurrency = summarizeClearSpending(rows);

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

	if (clearSpendingByCurrency.size > 0) {
		lines.push(
			"## Clear spending",
			"",
			"Only rows classified as `outcome` are counted here; transfers and holds are excluded.",
			"",
		);
		[...clearSpendingByCurrency.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.forEach(([currency, totals]) => {
				lines.push(
					`- ${currency}: ${formatMoney(totals.amount, currency)} across ${totals.count} transactions`,
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

async function listZenMoneyWorkingProfiles(cwd: string): Promise<ZenMoneyWorkingProfile[]> {
	const profiles = new Map<string, ZenMoneyWorkingProfile>();
	for (const entity of await listZenMoneyEntities(cwd)) {
		profiles.set(entity, {
			entity,
			policy: await readZenMoneyEntityPolicy(cwd, entity),
			policyPath: zenMoneyEntityPolicyPath(entity, cwd),
		});
	}

	const defaultEntity = normalizeZenMoneyEntity("default");
	if (!profiles.has(defaultEntity)) {
		profiles.set(defaultEntity, {
			entity: defaultEntity,
			policy: await readZenMoneyEntityPolicy(cwd, defaultEntity),
			policyPath: zenMoneyEntityPolicyPath(defaultEntity, cwd),
		});
	}

	return [...profiles.values()].sort((left, right) => left.entity.localeCompare(right.entity));
}

function resolveZenMoneySnapshotSelectors(
	explicitSelectors: string[],
	policy: ZenMoneyEntityPolicy,
	entity: string,
): string[] {
	const selectors = explicitSelectors.length > 0 ? explicitSelectors : (policy.selectors ?? []);
	if (selectors.length > 0) return selectors;

	const envSelectors = process.env.ZENMONEY_SNAPSHOT_SELECTORS?.trim();
	if (envSelectors) return splitSelectors(envSelectors);

	throw new Error(
		`No ZenMoney selectors configured for entity \`${entity}\`. Add ${zenMoneyEntityPolicyPath(entity)}, set ZENMONEY_SNAPSHOT_SELECTORS, or pass explicit selectors.`,
	);
}

async function resolveZenMoneyActiveEntity(cwd: string, explicitEntity?: string): Promise<string> {
	if (explicitEntity?.trim()) return normalizeZenMoneyEntity(explicitEntity);
	const workspace = await readZenMoneyWorkspaceConfig(cwd);
	return normalizeZenMoneyEntity(workspace.activeEntity);
}

function buildZenMoneyBalanceSummary(params: {
	entity: string;
	rows: BankTransactionRow[];
	selectors: string[];
	period: string | undefined;
	accounts: ResolvedAccount[];
	balances: Map<string, number>;
}): string {
	const transactionSummary = formatTransactionsSummary(
		params.rows,
		params.selectors,
		params.period,
		params.accounts,
	);
	const lines: string[] = [
		"# ZenMoney Balance",
		"",
		`- Entity: ${params.entity}`,
		`- Source: ZenMoney API`,
		`- Account selectors: ${params.selectors.join(", ")}`,
		`- Accounts matched: ${params.accounts.length}`,
		`- Transactions returned: ${params.rows.length}`,
		`- Period: ${params.period || "all available dates"}`,
		"",
		"## Current balances by currency",
	];

	if (params.balances.size > 0) {
		[...params.balances.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.forEach(([currency, balance]) => {
				lines.push(`- ${currency}: ${formatMoney(balance, currency)}`);
			});
	} else {
		lines.push("- No balance data available for selected accounts.");
	}

	lines.push("", "## Account balances", "");
	if (params.accounts.length === 0) {
		lines.push("No accounts matched.");
	} else {
		lines.push(
			"| Account | Currency | Balance | Sync IDs | Company | Archived |",
			"|---|---|---:|---|---|---|",
		);
		params.accounts.forEach((entry) => {
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
	snapshot: ZenMoneySnapshot;
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
		snapshot,
	};
}

async function readZenMoneyBalanceSnapshot(params: {
	cwd?: string;
	entity?: string;
	selectors?: string[];
	period?: string;
}): Promise<{
	entity: string;
	summary: string;
	csv: string;
	transactions: BankTransactionRow[];
	accounts: ResolvedAccount[];
	balancesByCurrency: Array<{ currency: string; balance: number }>;
	totalsByCurrency: Array<{ currency: string; income: number; outcome: number; net: number }>;
	transactionCount: number;
	tags: Map<string, string>;
}> {
	const cwd = params.cwd ?? process.cwd();
	const entity = await resolveZenMoneyActiveEntity(cwd, params.entity);
	const policy = await readZenMoneyEntityPolicy(cwd, entity);
	const selectors = resolveZenMoneySnapshotSelectors(params.selectors ?? [], policy, entity);
	const result = await readZenMoneyTransactions(selectors, params.period);
	await writeZenMoneyRegistry(cwd, entity, result.snapshot);
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

	const summary = buildZenMoneyBalanceSummary({
		entity,
		rows: result.transactions,
		selectors,
		period: params.period,
		accounts: result.accounts,
		balances: balancesByCurrencyMap,
	});

	return {
		entity,
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

function resolveZenMoneySnapshotBaseDir(params: {
	cwd: string;
	entity: string;
	snapshotPath?: string;
	policy: ZenMoneyEntityPolicy;
}): string {
	const configuredPath =
		params.snapshotPath?.trim() ||
		params.policy.snapshot_path?.trim() ||
		process.env.ZENMONEY_SNAPSHOT_PATH?.trim();
	return configuredPath
		? normalizeZenMoneySnapshotPath(configuredPath, "Snapshot path")
		: zenMoneyEntitySnapshotsDir(params.entity, params.cwd ?? process.cwd());
}

async function storeZenMoneyBalanceSnapshot(params: {
	cwd?: string;
	entity: string;
	selectors: string[];
	period?: string;
	snapshotPath?: string;
	summary: string;
	csv: string;
	accounts: ResolvedAccount[];
	balancesByCurrency: Array<{ currency: string; balance: number }>;
	totalsByCurrency: Array<{ currency: string; income: number; outcome: number; net: number }>;
	transactionCount: number;
	tags?: Map<string, string>;
}): Promise<{ jsonPath: string; csvPath: string }> {
	const cwd = params.cwd ?? process.cwd();
	const entity = normalizeZenMoneyEntity(params.entity);
	const selectorSlug = makeSelectorSlug(params.selectors);
	const periodPart = params.period || "all";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filePrefix = `${selectorSlug}-${periodPart}-${timestamp}`;
	const baseDir = resolveZenMoneySnapshotBaseDir({
		cwd,
		entity,
		snapshotPath: params.snapshotPath,
		policy: await readZenMoneyEntityPolicy(cwd, entity),
	});

	await fs.mkdir(baseDir, { recursive: true });

	const jsonPath = join(baseDir, `${filePrefix}.json`);
	const csvPath = join(baseDir, `${filePrefix}.csv`);

	const payload = {
		entity,
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

	await fs.writeFile(
		jsonPath,
		`${JSON.stringify(payload, null, 2)}
`,
		"utf8",
	);
	await fs.writeFile(csvPath, params.csv, "utf8");

	return { jsonPath, csvPath };
}

async function sendZenMoneyReport(pi: ExtensionAPI, title: string, body: string) {
	pi.sendMessage({
		customType: "zenmoney-report",
		content: `${title}\n\n${body}`,
		display: true,
	});
}

// @lat: [[extension#ZenMoney Live Bank Data]]
export default function registerZenMoneyExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(
		"zenmoney-report",
		(message: { content: string }, { expanded }: { expanded: boolean }, theme: Theme) =>
			renderPreview(message.content, expanded, theme),
	);

	const openZenMoneyHub = async (_args: string, ctx: CommandContext) =>
		runZenMoneyBoundary(
			ctx,
			Effect.gen(function* () {
				const snapshot = yield* effectFromZenMoneyPromise(() => fetchZenMoneySnapshot());
				const accounts = listSelectableAccounts(snapshot, undefined, false);
				const allAccounts = listSelectableAccounts(snapshot, undefined, true);
				const profiles = yield* effectFromZenMoneyPromise(() =>
					listZenMoneyWorkingProfiles(ctx.cwd),
				);
				const workspace = yield* effectFromZenMoneyPromise(() =>
					readZenMoneyWorkspaceConfig(ctx.cwd),
				);
				const result = yield* effectFromZenMoneyPromise(() =>
					ctx.ui.custom<ZenMoneyHubResult | null>(
						(tui, theme, _kb, done) =>
							new ZenMoneyHubEditor(
								tui,
								theme,
								done,
								profiles,
								accounts,
								allAccounts,
								workspace.activeEntity,
							),
						{ overlay: true },
					),
				);

				if (!result) return;

				if (result.kind === "delete") {
					yield* effectFromZenMoneyPromise(() => deleteZenMoneyEntity(ctx.cwd, result.entity));
					const nextActiveEntity = profiles.find(
						(profile) => profile.entity !== result.entity,
					)?.entity;
					yield* effectFromZenMoneyPromise(() =>
						writeZenMoneyWorkspaceConfig(
							ctx.cwd,
							nextActiveEntity ? { activeEntity: nextActiveEntity } : {},
						),
					);
					yield* Effect.sync(() => {
						ctx.ui.notify(`Deleted ZenMoney profile ${result.entity}`, "info");
					});
					return;
				}

				const currentProfile = profiles.find((profile) => profile.entity === result.entity);
				const saved = yield* effectFromZenMoneyPromise(() =>
					writeZenMoneyEntityPolicy(ctx.cwd, result.entity, {
						...(currentProfile?.policy ?? {}),
						selectors: result.selectors,
						snapshot_path: result.snapshotPath,
					}),
				);
				yield* effectFromZenMoneyPromise(() =>
					writeZenMoneyWorkspaceConfig(ctx.cwd, { activeEntity: result.entity }),
				);

				if (result.kind === "balance") {
					const balance = yield* effectFromZenMoneyPromise(() =>
						readZenMoneyBalanceSnapshot({
							cwd: ctx.cwd,
							entity: result.entity,
							selectors: result.selectors,
						}),
					);
					yield* Effect.sync(() => {
						sendZenMoneyReport(pi, `ZenMoney balance ${result.entity}`, balance.summary);
					});
					return;
				}

				yield* Effect.sync(() => {
					ctx.ui.notify(`Saved ZenMoney settings for ${result.entity} to ${saved}`, "info");
				});
			}),
		);

	pi.registerCommand("zenmoney", {
		description: "Open the ZenMoney settings hub",
		handler: openZenMoneyHub,
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

	pi.registerTool({
		name: "zenmoney_balance",
		label: "ZenMoney Balance",
		description: "Summarize ZenMoney entity-scoped balance snapshots",
		promptSnippet: "Summarize ZenMoney balances and monthly totals before reporting",
		promptGuidelines: [
			"Use explicit selectors when you want to bypass the entity policy.",
			"Pass an entity name to keep snapshot exports isolated per scope.",
			"Use period to narrow results to one month, for example 2026-03.",
			"Enable store=true to persist JSON and CSV snapshots under the configured relative snapshot folder.",
		],
		parameters: Type.Object({
			entity: Type.Optional(
				Type.String({ description: "Optional entity name such as business or default" }),
			),
			selectors: Type.Optional(
				Type.Array(
					Type.String({ description: "Account selectors such as titles, ids, or last digits" }),
				),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-03" })),
			snapshotPath: Type.Optional(Type.String({ description: "Relative snapshot folder path" })),
			store: Type.Optional(
				Type.Boolean({ description: "Persist a local ZenMoney snapshot (JSON + CSV)" }),
			),
		}),
		async execute(
			_id: string,
			params: {
				entity?: string;
				selectors?: string[];
				period?: string;
				snapshotPath?: string;
				store?: boolean;
			},
		) {
			const result = await readZenMoneyBalanceSnapshot({
				entity: params.entity,
				selectors: params.selectors,
				period: params.period,
			});

			let saved: { jsonPath: string; csvPath: string } | undefined;
			if (params.store) {
				saved = await storeZenMoneyBalanceSnapshot({
					entity: result.entity,
					selectors: params.selectors ?? [],
					period: params.period,
					snapshotPath: params.snapshotPath,
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
					entity: result.entity,
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
		renderCall(
			args: {
				entity?: string;
				selectors?: string[];
				period?: string;
				snapshotPath?: string;
				store?: boolean;
			},
			theme: Theme,
		) {
			const scope = args.selectors?.length ? args.selectors.join(",") : (args.entity ?? "default");
			const pathSuffix = args.snapshotPath ? ` @ ${args.snapshotPath}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("zenmoney_balance "))}${theme.fg("dim", `${scope}${pathSuffix} ${args.period || "all"}${args.store ? " --store" : ""}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "zenmoney_read_transactions",
		label: "ZenMoney Read Transactions",
		description: "Fetch normalized ZenMoney transactions for the active or selected account set",
		promptSnippet: "Fetch actual bank data from ZenMoney for the active or selected account set",
		promptGuidelines: [
			"Use the active ZenMoney profile when selectors are omitted, or pass entity to override it.",
			"Use zenmoney_list_accounts first when you need to choose the relevant accounts.",
			"Pass selectors that match account id, title substring, company substring, or syncID / last digits.",
			"Use period to narrow results to one month, for example 2026-03.",
		],
		parameters: Type.Object({
			entity: Type.Optional(
				Type.String({ description: "Optional entity name such as business or default" }),
			),
			selectors: Type.Optional(
				Type.Array(
					Type.String({ description: "Account selectors such as titles, ids, or last digits" }),
				),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-03" })),
		}),
		async execute(_id: string, params: { entity?: string; selectors?: string[]; period?: string }) {
			const cwd = process.cwd();
			const entity = await resolveZenMoneyActiveEntity(cwd, params.entity);
			const policy = await readZenMoneyEntityPolicy(cwd, entity);
			const selectors = resolveZenMoneySnapshotSelectors(params.selectors ?? [], policy, entity);
			const result = await readZenMoneyTransactions(selectors, params.period);
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
		renderCall(args: { entity?: string; selectors?: string[]; period?: string }, theme: Theme) {
			const scope = args.selectors?.length ? args.selectors.join(",") : (args.entity ?? "active");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("zenmoney_read_transactions "))}${theme.fg("dim", `${scope}${args.period ? ` ${args.period}` : ""}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});
}
