import type { SOURCE_VALUES } from "./constants.ts";

export type SourceKind = (typeof SOURCE_VALUES)[number];

export interface ZenMoneyInstrument {
	id: number;
	title?: string;
	shortTitle?: string;
	symbol?: string;
}

export interface ZenMoneyCompany {
	id: number;
	title?: string;
	fullTitle?: string;
	country?: string;
}

export interface ZenMoneyAccount {
	id: string;
	instrument?: number | null;
	company?: number | null;
	type?: string;
	title?: string;
	syncID?: string[] | null;
	balance?: number | null;
	archive?: boolean;
}

export interface ZenMoneyMerchant {
	id: string;
	title?: string;
}

export interface ZenMoneyTransaction {
	id?: string;
	deleted?: boolean;
	hold?: boolean | null;
	incomeInstrument?: number | null;
	incomeAccount?: string;
	income?: number;
	outcomeInstrument?: number | null;
	outcomeAccount?: string;
	outcome?: number;
	merchant?: string | null;
	payee?: string | null;
	originalPayee?: string | null;
	comment?: string | null;
	date?: string;
	mcc?: number | null;
	tag?: string | string[] | null;
}

export interface ZenMoneyCategory {
	id?: string;
	title?: string;
	parentId?: string | null;
}

export interface ZenMoneySnapshot {
	fetchedAt: number;
	serverTimestamp: number;
	instruments: ZenMoneyInstrument[];
	companies: ZenMoneyCompany[];
	accounts: ZenMoneyAccount[];
	merchants: ZenMoneyMerchant[];
	transactions: ZenMoneyTransaction[];
	tags?: ZenMoneyCategory[];
}

export interface BankTransactionRow {
	date: string;
	amount: number;
	currency: string;
	partner: string;
	description: string;
	transactionType: string;
	reference: string;
	sourceFile: string;
	source: SourceKind;
	accountId: string;
	accountTitle: string;
	categoryId?: string | null;
	categoryName?: string | null;
}

export interface ZenMoneyRegisterPolicy {
	register_selectors?: string[];
	review_only_selectors?: string[];
}

export interface ZenMoneyClassificationRule {
	match?: string;
	bucket?: string;
	category?: string;
	requires_review?: boolean;
	note?: string;
}

export interface ZenMoneyClassificationRules {
	rules?: ZenMoneyClassificationRule[];
	internal_transfer_hints?: string[];
}

export interface ZenMoneyRegisterResult {
	period: string;
	registerPath: string;
	dryRun: boolean;
	fetchedRows: number;
	existingRows: number;
	newRows: number;
	updatedRows: number;
	totalRows: number;
	summary: string;
	warnings: string[];
}

export interface CurrencyTotals {
	currency: string;
	income: number;
	outcome: number;
	net: number;
}
