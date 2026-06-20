# ZenMoney Pi extension

This repo packages a Pi extension for ZenMoney account discovery, transaction export, and entity-scoped balance snapshots.

## Repository overview

`package.json` points Pi at the extension entrypoint, and the README documents install, token setup, and the supported ZenMoney command surface.

- `/zenmoney` opens the settings hub for profiles, accounts, snapshot-path setup, and an inline balance summary.
- `/zen-accounts` lists selectable ZenMoney accounts.
- `/zen-profiles` remains a compatibility alias for the profile editor.
- `/zen-transactions` exports normalized transactions for chosen accounts.
- `/zen-balance` summarizes balances and monthly totals per entity.

## Docs

This index points to the two topic files that `lat_check` expects this package to expose.

- [[extension]] — extension surface, commands, and live bank data.
- [[data-workflows]] — entity-scoped snapshot workflow and local ZenMoney data files.
- [[tests]] — snapshot workflow cases that are worth automated coverage.

## Source layout

The source is split into a thin entrypoint, the ZenMoney command/tool implementation, the unified settings hub, and small shared modules for constants, types, and secret resolution.

### `src/index.ts`

Thin adapter that hands Pi's extension API to [[src/zenmoney.ts#registerZenMoneyExtension]].

### `src/zenmoney.ts`

Contains the command and tool registrations plus the core data flow: snapshot fetch, account matching, transaction normalization, and balance snapshots.

Key helpers: [[src/zenmoney.ts#fetchZenMoneySnapshot]], [[src/zenmoney.ts#listZenMoneyAccounts]], [[src/zenmoney.ts#readZenMoneyTransactions]], [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]], [[src/zenmoney.ts#storeZenMoneyBalanceSnapshot]].

### `src/hub.ts`

Implements the unified settings TUI for selecting profiles, selecting accounts, and editing snapshot paths before saving entity policy changes.

### `src/constants.ts` and `src/types.ts`

Shared constants define preview sizing and source markers, while the types file models ZenMoney API payloads and the entity policy shape used by snapshots.

### `src/secret-refs.ts`

Resolves raw tokens and `op://` / `op read` secret references before any ZenMoney API request.

## Behavior notes

Account selectors match id, title, company, syncID, or last digits. Snapshot exports can use `--entity` and `--snapshot-path`, and the path must stay relative to working files.

The `/zen-profiles` command opens a TUI for browsing profiles and current accounts with separate live search filters; archived accounts are hidden by default, typing a new name can create a profile, space toggles the highlighted account, and enter saves the chosen selectors back to the profile policy.

The `/zenmoney` hub shows an inline balance summary for the currently selected entity and accounts, reusing the same selector and snapshot-path state.

By default, snapshots still land under `ZenMoney/Entities/<entity>/Snapshots`, and selectors can fall back to entity policy or `ZENMONEY_SNAPSHOT_SELECTORS`.
