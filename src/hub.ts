import type { Theme } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ResolvedAccount, ZenMoneyEntityPolicy } from "./types.ts";

type ZenMoneyHubResult = {
	entity: string;
	selectors: string[];
	snapshotPath: string;
};

interface ZenMoneyWorkingProfile {
	entity: string;
	policy: ZenMoneyEntityPolicy;
	policyPath: string;
}

function normalizeText(value: string): string {
	return value.trim().toLowerCase();
}

function normalizeDigits(value: string): string {
	return value.replace(/\D+/g, "");
}

function matchesSearchQuery(query: string, values: string[]): boolean {
	const normalizedQuery = normalizeText(query);
	const digitQuery = normalizeDigits(query);
	return values.some((value) => {
		const normalizedValue = normalizeText(value);
		if (normalizedQuery && normalizedValue.includes(normalizedQuery)) return true;
		if (digitQuery && normalizeDigits(value).includes(digitQuery)) return true;
		return false;
	});
}

function isReturnInput(data: string): boolean {
	return matchesKey(data, "enter") || matchesKey(data, "return");
}

function isSpaceInput(data: string): boolean {
	return data === " " || matchesKey(data, "space");
}

function isTabInput(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isPrintableSearchInput(data: string): boolean {
	return (
		data.length === 1 && data !== " " && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127
	);
}

function isPrintableTextInput(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127;
}

function normalizeZenMoneyEntity(entity?: string): string {
	const normalized = normalizeText(entity ?? "default")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return normalized || "default";
}

function entityPolicyPath(entity: string, baseDir = ""): string {
	return [baseDir, "ZenMoney", "Entities", normalizeZenMoneyEntity(entity), "entity-policy.json"]
		.filter(Boolean)
		.join("/");
}

function entitySnapshotsDir(entity: string, baseDir = ""): string {
	return [baseDir, "ZenMoney", "Entities", normalizeZenMoneyEntity(entity), "Snapshots"]
		.filter(Boolean)
		.join("/");
}

function normalizeZenMoneySnapshotPath(pathValue: string, label: string): string {
	const trimmed = pathValue.trim();
	if (!trimmed) throw new Error(`${label} must not be empty.`);
	if (trimmed.startsWith("/"))
		throw new Error(`${label} must be relative to the working files folder.`);
	const normalized = trimmed.replace(/\\+/g, "/");
	if (normalized.split("/").some((segment) => segment === "..")) {
		throw new Error(`${label} must not escape the working files folder.`);
	}
	return normalized;
}

function matchingAccountIdsBySelectors(
	accounts: ResolvedAccount[],
	selectors: string[],
): Set<string> {
	const selected = new Set<string>();
	const normalizedSelectors = selectors.map((selector) => normalizeText(selector));
	const digitSelectors = selectors.map((selector) => normalizeDigits(selector));

	for (const account of accounts) {
		const values = [
			account.account.id,
			account.account.title ?? "",
			account.company,
			account.currency,
			(account.account.syncID ?? []).join(" "),
		];
		const matches = values.some((value) => {
			const normalizedValue = normalizeText(value);
			const digitValue = normalizeDigits(value);
			return (
				normalizedSelectors.some((selector) => selector && normalizedValue.includes(selector)) ||
				digitSelectors.some((selector) => selector && digitValue.includes(selector))
			);
		});
		if (matches) selected.add(account.account.id);
	}

	return selected;
}

export class ZenMoneyHubEditor {
	private mode: "profiles" | "accounts" | "settings" = "profiles";
	private selectedProfileEntity: string;
	private selectedAccountId: string | null;
	private selectedAccountIds = new Set<string>();
	private draftProfileEntity: string | null = null;
	private draftOriginProfileEntity: string | null = null;
	private profileSearchQuery = "";
	private accountSearchQuery = "";
	private snapshotPathDraft = "";
	private snapshotPathBase = "";
	private errorMessage = "";

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly done: (result: ZenMoneyHubResult | null) => void,
		private readonly profiles: ZenMoneyWorkingProfile[],
		private readonly accounts: ResolvedAccount[],
		private readonly allAccounts: ResolvedAccount[],
	) {
		const firstProfile = this.profiles[0];
		if (!firstProfile) throw new Error("No ZenMoney profiles available.");
		this.selectedProfileEntity = firstProfile.entity;
		this.selectedAccountId = this.accounts[0]?.account.id ?? null;
		this.syncProfileSelection();
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private currentProfile(): ZenMoneyWorkingProfile {
		if (this.draftProfileEntity) {
			return {
				entity: this.draftProfileEntity,
				policy: { snapshot_path: this.snapshotPathDraft },
				policyPath: entityPolicyPath(this.draftProfileEntity),
			};
		}
		const profile = this.profiles.find((entry) => entry.entity === this.selectedProfileEntity);
		if (profile) return profile;
		const firstProfile = this.profiles[0];
		if (!firstProfile) throw new Error("No ZenMoney profiles available.");
		return firstProfile;
	}

	private currentSnapshotPath(): string {
		return (
			this.snapshotPathDraft ||
			this.snapshotPathBase ||
			entitySnapshotsDir(this.currentProfile().entity)
		);
	}

	private resolvedSnapshotPath(): string {
		return normalizeZenMoneySnapshotPath(this.currentSnapshotPath(), "Snapshot path");
	}

	private profileSnapshotPath(profile: ZenMoneyWorkingProfile): string {
		return profile.policy.snapshot_path || entitySnapshotsDir(profile.entity);
	}

	private syncSnapshotPathDraft(profile?: ZenMoneyWorkingProfile): void {
		const current = profile ?? this.currentProfile();
		const next = this.profileSnapshotPath(current);
		this.snapshotPathBase = next;
		this.snapshotPathDraft = next;
	}

	private filteredProfiles(): ZenMoneyWorkingProfile[] {
		const query = this.profileSearchQuery.trim();
		if (!query) return this.profiles;
		return this.profiles.filter((profile) => this.profileMatchesQuery(profile, query));
	}

	private filteredAccounts(): ResolvedAccount[] {
		const query = this.accountSearchQuery.trim();
		if (!query) return this.accounts;
		return this.accounts.filter((account) => this.accountMatchesQuery(account, query));
	}

	private profileMatchesQuery(profile: ZenMoneyWorkingProfile, query: string): boolean {
		return matchesSearchQuery(query, [
			profile.entity,
			profile.policy.snapshot_path ?? "",
			(profile.policy.selectors ?? []).join(" "),
		]);
	}

	private accountMatchesQuery(account: ResolvedAccount, query: string): boolean {
		return matchesSearchQuery(query, [
			account.account.id,
			account.account.title ?? "",
			account.company,
			account.currency,
			(account.account.syncID ?? []).join(" "),
			String(account.account.balance ?? ""),
			account.account.archive ? "archived" : "active",
		]);
	}

	private profileSummary(profile: ZenMoneyWorkingProfile): string {
		if (profile.entity === this.draftProfileEntity) {
			return `new profile • ${this.currentSnapshotPath()}`;
		}
		const selectedCount = matchingAccountIdsBySelectors(
			this.allAccounts,
			profile.policy.selectors ?? [],
		).size;
		const snapshotPath = this.profileSnapshotPath(profile);
		return `${selectedCount} selected • ${snapshotPath}`;
	}

	private selectedProfileTitle(): string {
		const profile = this.currentProfile();
		return profile.entity === this.draftProfileEntity ? `${profile.entity} (new)` : profile.entity;
	}

	private visibleProfileIndex(): number {
		const visible = this.filteredProfiles();
		if (visible.length === 0) return 0;
		const currentIndex = visible.findIndex(
			(profile) => profile.entity === this.selectedProfileEntity,
		);
		return currentIndex >= 0 ? currentIndex : 0;
	}

	private visibleAccountIndex(): number {
		const visible = this.filteredAccounts();
		if (visible.length === 0) return 0;
		const currentIndex = visible.findIndex((entry) => entry.account.id === this.selectedAccountId);
		return currentIndex >= 0 ? currentIndex : 0;
	}

	private windowRange(total: number, cursor: number, size: number): [number, number] {
		if (total <= size) return [0, total];
		const half = Math.floor(size / 2);
		const start = Math.max(0, Math.min(total - size, cursor - half));
		return [start, Math.min(total, start + size)];
	}

	private currentVisibleAccount(): ResolvedAccount | undefined {
		const visible = this.filteredAccounts();
		return visible[this.visibleAccountIndex()];
	}

	private syncProfileSelection(): void {
		if (this.draftProfileEntity) {
			this.selectedAccountIds = new Set<string>();
			this.selectedAccountId =
				this.filteredAccounts()[0]?.account.id ?? this.allAccounts[0]?.account.id ?? null;
			return;
		}
		const profile = this.currentProfile();
		this.selectedAccountIds = matchingAccountIdsBySelectors(
			this.allAccounts,
			profile.policy.selectors ?? [],
		);
		const visibleAccounts = this.filteredAccounts();
		const selectedVisibleAccount =
			visibleAccounts.find((entry) => this.selectedAccountIds.has(entry.account.id)) ??
			visibleAccounts[0] ??
			this.allAccounts.find((entry) => this.selectedAccountIds.has(entry.account.id)) ??
			this.allAccounts[0];
		this.selectedAccountId = selectedVisibleAccount?.account.id ?? null;
		this.syncSnapshotPathDraft(profile);
	}

	private ensureProfileSelectionVisible(): void {
		if (this.draftProfileEntity) return;
		const visible = this.filteredProfiles();
		if (visible.length === 0) return;
		if (!visible.some((profile) => profile.entity === this.selectedProfileEntity)) {
			this.selectedProfileEntity = visible[0].entity;
			this.syncProfileSelection();
		}
	}

	private ensureAccountSelectionVisible(): void {
		const visible = this.filteredAccounts();
		if (visible.length === 0) return;
		if (!visible.some((entry) => entry.account.id === this.selectedAccountId)) {
			this.selectedAccountId = visible[0].account.id;
		}
	}

	private clearDraftProfile(): void {
		if (!this.draftProfileEntity) return;
		this.draftProfileEntity = null;
		this.selectedProfileEntity =
			this.draftOriginProfileEntity ?? this.profiles[0]?.entity ?? this.selectedProfileEntity;
		this.draftOriginProfileEntity = null;
		this.syncProfileSelection();
	}

	private createProfileEntity(): string | null {
		const entity = normalizeZenMoneyEntity(this.profileSearchQuery);
		if (!entity) return null;
		if (this.profiles.some((profile) => profile.entity === entity)) return null;
		return entity;
	}

	private activateDraftProfile(entity: string): void {
		this.draftOriginProfileEntity = this.selectedProfileEntity;
		this.draftProfileEntity = entity;
		this.selectedProfileEntity = entity;
		this.snapshotPathBase = entitySnapshotsDir(entity);
		this.snapshotPathDraft = this.snapshotPathBase;
		this.selectedAccountIds = new Set<string>();
		this.selectedAccountId =
			this.filteredAccounts()[0]?.account.id ?? this.allAccounts[0]?.account.id ?? null;
	}

	private selectProfileByIndex(index: number): void {
		const profile = this.filteredProfiles()[index];
		if (!profile) return;
		this.clearDraftProfile();
		this.selectedProfileEntity = profile.entity;
		this.syncProfileSelection();
		this.refresh();
	}

	private moveProfile(delta: number): void {
		const visible = this.filteredProfiles();
		if (visible.length === 0) return;
		const nextIndex = Math.max(0, Math.min(visible.length - 1, this.visibleProfileIndex() + delta));
		this.clearDraftProfile();
		this.selectProfileByIndex(nextIndex);
	}

	private moveAccount(delta: number): void {
		const visible = this.filteredAccounts();
		if (visible.length === 0) return;
		const nextIndex = Math.max(0, Math.min(visible.length - 1, this.visibleAccountIndex() + delta));
		const account = visible[nextIndex];
		if (!account) return;
		this.selectedAccountId = account.account.id;
		this.refresh();
	}

	private toggleSelectedAccount(): void {
		const account = this.currentVisibleAccount();
		if (!account) return;
		const id = account.account.id;
		if (this.selectedAccountIds.has(id)) this.selectedAccountIds.delete(id);
		else this.selectedAccountIds.add(id);
	}

	private cycleMode(): void {
		if (this.mode === "profiles") this.mode = "accounts";
		else if (this.mode === "accounts") this.mode = "settings";
		else this.mode = "profiles";
		this.refresh();
	}

	private updateSearchQuery(mode: "profiles" | "accounts", nextValue: string): void {
		this.errorMessage = "";
		if (mode === "profiles") {
			this.profileSearchQuery = nextValue;
			this.ensureProfileSelectionVisible();
			this.refresh();
			return;
		}

		this.accountSearchQuery = nextValue;
		this.ensureAccountSelectionVisible();
		this.refresh();
	}

	private appendSearchText(mode: "profiles" | "accounts", data: string): void {
		if (!isPrintableSearchInput(data)) return;
		const current = mode === "profiles" ? this.profileSearchQuery : this.accountSearchQuery;
		this.updateSearchQuery(mode, `${current}${data}`);
	}

	private popSearchText(mode: "profiles" | "accounts"): boolean {
		const current = mode === "profiles" ? this.profileSearchQuery : this.accountSearchQuery;
		if (!current) return false;
		this.updateSearchQuery(mode, current.slice(0, -1));
		return true;
	}

	private clearSearchText(mode: "profiles" | "accounts"): boolean {
		const current = mode === "profiles" ? this.profileSearchQuery : this.accountSearchQuery;
		if (!current) return false;
		this.updateSearchQuery(mode, "");
		return true;
	}

	private appendSnapshotPathText(data: string): void {
		if (!isPrintableTextInput(data)) return;
		this.errorMessage = "";
		this.snapshotPathDraft = `${this.snapshotPathDraft}${data}`;
		this.refresh();
	}

	private popSnapshotPathText(): boolean {
		if (!this.snapshotPathDraft) return false;
		this.errorMessage = "";
		this.snapshotPathDraft = this.snapshotPathDraft.slice(0, -1);
		this.refresh();
		return true;
	}

	private clearSnapshotPathText(): boolean {
		if (this.snapshotPathDraft === this.snapshotPathBase) return false;
		this.errorMessage = "";
		this.snapshotPathDraft = this.snapshotPathBase;
		this.refresh();
		return true;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "profiles") {
			if (isTabInput(data)) {
				this.cycleMode();
				return;
			}
			if (matchesKey(data, "escape")) {
				if (this.clearSearchText("profiles")) return;
				this.done(null);
				return;
			}
			if (matchesKey(data, "ctrl+c")) {
				this.done(null);
				return;
			}
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
				if (this.popSearchText("profiles")) return;
				return;
			}
			if (matchesKey(data, "up")) {
				this.moveProfile(-1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.moveProfile(1);
				return;
			}
			if (isReturnInput(data)) {
				const profileEntity = this.createProfileEntity();
				if (profileEntity) {
					this.activateDraftProfile(profileEntity);
					this.mode = "accounts";
					this.refresh();
					return;
				}
				this.mode = "accounts";
				this.ensureAccountSelectionVisible();
				this.refresh();
				return;
			}
			this.appendSearchText("profiles", data);
			return;
		}

		if (this.mode === "accounts") {
			if (isTabInput(data)) {
				this.cycleMode();
				return;
			}
			if (matchesKey(data, "escape")) {
				if (this.clearSearchText("accounts")) return;
				if (this.draftProfileEntity) {
					this.clearDraftProfile();
					this.refresh();
					return;
				}
				this.mode = "profiles";
				this.refresh();
				return;
			}
			if (matchesKey(data, "ctrl+c")) {
				this.done(null);
				return;
			}
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
				if (this.popSearchText("accounts")) return;
				return;
			}
			if (matchesKey(data, "up")) {
				this.moveAccount(-1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.moveAccount(1);
				return;
			}
			if (isSpaceInput(data)) {
				this.toggleSelectedAccount();
				this.refresh();
				return;
			}
			if (isReturnInput(data)) {
				this.mode = "settings";
				this.refresh();
				return;
			}
			this.appendSearchText("accounts", data);
			return;
		}

		if (isTabInput(data)) {
			this.cycleMode();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.clearSnapshotPathText()) return;
			this.mode = "accounts";
			this.refresh();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			if (this.popSnapshotPathText()) return;
			return;
		}
		if (isReturnInput(data)) {
			if (this.selectedAccountIds.size === 0) return;
			try {
				const profile = this.currentProfile();
				this.done({
					entity: profile.entity,
					selectors: [...this.selectedAccountIds].sort((left, right) => left.localeCompare(right)),
					snapshotPath: this.resolvedSnapshotPath(),
				});
			} catch (error) {
				this.errorMessage = error instanceof Error ? error.message : String(error);
				this.refresh();
			}
			return;
		}
		this.appendSnapshotPathText(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const panel = (content: string) => truncateToWidth(content, innerWidth, "...", true);
		const border = (value: string) => this.theme.fg("border", value);
		const lines: string[] = [];
		const profile = this.currentProfile();
		const visibleProfiles = this.filteredProfiles();
		const visibleAccounts = this.filteredAccounts();
		const profileIndex = this.visibleProfileIndex();
		const accountIndex = this.visibleAccountIndex();
		const profilesWindow = this.windowRange(visibleProfiles.length, profileIndex, 5);
		const accountsWindow = this.windowRange(visibleAccounts.length, accountIndex, 8);

		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(
			border("│") + panel(this.theme.fg("accent", " ZenMoney Settings Hub")) + border("│"),
		);
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						"dim",
						` mode: ${this.mode} • tab cycles • enter advances/saves • esc clears/back`,
					),
				) +
				border("│"),
		);
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						"accent",
						` Profile: ${this.selectedProfileTitle()} • accounts: ${this.selectedAccountIds.size} • snapshot: ${this.currentSnapshotPath()}`,
					),
				) +
				border("│"),
		);
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		lines.push(
			border("│") +
				panel(
					this.theme.fg("accent", ` Profiles (${visibleProfiles.length}/${this.profiles.length})`),
				) +
				border("│"),
		);

		if (visibleProfiles.length === 0) {
			lines.push(
				border("│") +
					panel(
						this.theme.fg(
							"dim",
							` no profiles match ${this.profileSearchQuery || "the current filter"}`,
						),
					) +
					border("│"),
			);
		} else {
			for (let index = profilesWindow[0]; index < profilesWindow[1]; index += 1) {
				const entry = visibleProfiles[index];
				if (!entry) continue;
				const isSelected = entry.entity === this.selectedProfileEntity;
				const prefix = isSelected ? this.theme.fg("accent", "▶ ") : "  ";
				const name = isSelected ? this.theme.fg("accent", entry.entity) : entry.entity;
				const summary = this.profileSummary(entry);
				lines.push(border("│") + panel(`${prefix}${name} — ${summary}`) + border("│"));
			}
		}

		const createProfileEntity = this.createProfileEntity();
		if (createProfileEntity) {
			lines.push(
				border("│") +
					panel(this.theme.fg("success", ` ＋ Create profile "${createProfileEntity}"`)) +
					border("│"),
			);
		}

		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		lines.push(
			border("│") + panel(this.theme.fg("accent", ` Accounts for ${profile.entity}`)) + border("│"),
		);
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						"dim",
						` accounts search: ${this.accountSearchQuery || "—"} • selected: ${this.selectedAccountIds.size}`,
					),
				) +
				border("│"),
		);

		if (visibleAccounts.length === 0) {
			lines.push(
				border("│") +
					panel(
						this.theme.fg(
							"dim",
							` no accounts match ${this.accountSearchQuery || "the current filter"}`,
						),
					) +
					border("│"),
			);
		} else {
			for (let index = accountsWindow[0]; index < accountsWindow[1]; index += 1) {
				const entry = visibleAccounts[index];
				if (!entry) continue;
				const isSelected = entry.account.id === this.selectedAccountId;
				const isChecked = this.selectedAccountIds.has(entry.account.id);
				const prefix = isSelected ? this.theme.fg("accent", "▶ ") : "  ";
				const check = isChecked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
				const label = entry.account.title || entry.account.id;
				const detail = `${label} · ${entry.company} · ${entry.currency}`;
				lines.push(
					border("│") +
						panel(`${prefix}${check} ${isSelected ? this.theme.fg("accent", detail) : detail}`) +
						border("│"),
				);
			}
		}

		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		lines.push(border("│") + panel(this.theme.fg("accent", " Snapshot path")) + border("│"));
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						this.mode === "settings" ? "success" : "dim",
						` ${this.snapshotPathDraft || this.snapshotPathBase} ${this.mode === "settings" ? "(editing)" : ""}`,
					),
				) +
				border("│"),
		);
		if (this.errorMessage) {
			lines.push(
				border("│") + panel(this.theme.fg("error", ` ${this.errorMessage}`)) + border("│"),
			);
		}
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						"dim",
						this.mode === "settings"
							? " settings: type to edit path • enter saves • esc restores/back"
							: " settings: tab to edit snapshot path",
					),
				) +
				border("│"),
		);
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		lines.push(
			border("│") +
				panel(
					this.theme.fg("dim", " Profiles: type to filter • ↑↓ move • Enter accounts • Tab next"),
				) +
				border("│"),
		);
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						"dim",
						" Accounts: type to filter • ↑↓ move • Space toggle • Enter settings • Tab next",
					),
				) +
				border("│"),
		);
		lines.push(
			border("│") +
				panel(
					this.theme.fg(
						"dim",
						" Settings: type to edit path • Enter save • Esc restore/back • Tab next",
					),
				) +
				border("│"),
		);
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

		return lines;
	}
}
