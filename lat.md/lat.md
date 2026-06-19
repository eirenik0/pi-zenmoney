# ZenMoney Pi extension

This repo packages a Pi extension for ZenMoney account discovery, transaction export, balance snapshots, and a register workflow.

## Repository overview

`package.json` points Pi at the extension entrypoint, and the README documents install, token setup, and the four supported user commands.

- `/zen-accounts` lists selectable ZenMoney accounts.
- `/zen-transactions` exports normalized transactions for chosen accounts.
- `/zen-balance` summarizes balances and monthly totals.
- `/zen-register` previews or writes the canonical transaction register.

## Docs

This index points to the two topic files that `lat_check` expects this package to expose.

- [[extension]] — extension surface, commands, and live bank data.
- [[data-workflows]] — transaction register workflow and local ZenMoney data files.

## Source layout

The source is split into a thin entrypoint, the ZenMoney command/tool implementation, and small shared modules for constants, types, and secret resolution.

### `src/index.ts`

Thin adapter that hands Pi's extension API to [[src/zenmoney.ts#registerZenMoneyExtension]].

### `src/zenmoney.ts`

Contains the command and tool registrations plus the core data flow: snapshot fetch, account matching, transaction normalization, balance summaries, and register generation.

Key helpers: [[src/zenmoney.ts#fetchZenMoneySnapshot]], [[src/zenmoney.ts#listZenMoneyAccounts]], [[src/zenmoney.ts#readZenMoneyTransactions]], [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]], [[src/zenmoney.ts#prepareZenMoneyRegister]].

### `src/constants.ts` and `src/types.ts`

Shared constants define preview sizing, source markers, and JSONL column order, while the types file models ZenMoney API payloads and the derived transaction/register shapes.

### `src/secret-refs.ts`

Resolves raw tokens and `op://` / `op read` secret references before any ZenMoney API request.

## Behavior notes

Account selectors match id, title, company, syncID, or last digits. Register flows use ZenMoney policy/classification files and store snapshots/registers locally.
