# Tests

This section captures the ZenMoney workflows that are most important to keep stable as the snapshot pipeline evolves.

## Snapshot selector resolution

Explicit selectors should win, then entity policy selectors, then `ZENMONEY_SNAPSHOT_SELECTORS`; missing configuration should fail clearly.

## Snapshot path resolution

`--snapshot-path` and tool `snapshotPath` should win over entity policy `snapshot_path`, then `ZENMONEY_SNAPSHOT_PATH`, then the default entity snapshot folder.

## Snapshot path validation

Accepted snapshot paths must stay relative to the working files folder and reject absolute paths or `..` traversal.

## Balance snapshot persistence

Storing a snapshot should write matching JSON and CSV files into the resolved folder and preserve entity, period, selector, and totals metadata.

## Hub and tool parity

The balance summary shown in `/zenmoney` and `zenmoney_balance` should agree on entity scoping, snapshot path handling, and stored output shape.

## Profile browsing

The interactive editor should list available profiles, hide archived accounts by default, let users opt in to showing archived accounts, show the selected profile's current accounts, and keep navigation stable when the profile list changes.

## Profile creation

Typing a new entity name in the profile search and pressing Enter should create a draft profile that can be saved to a new `.pi/zenmoney/entities/<entity>/policy.json`.

## Profile search filtering

Typing should filter the active profile or account list live, with separate search text per pane, so users can narrow choices without leaving the editor.

## Profile account toggle

Space should toggle the highlighted account in the account pane, even while account search filtering is active.

## Profile search clear

Backspace and Delete should delete one search character, while Esc should clear the whole active search first and only back out when the search is already empty.

## Profile save

Saving from the editor should persist selected account ids to the chosen profile policy while preserving any existing snapshot path and hidden archived selections.

## Profile cancel

Ctrl+C and empty-search Escape should discard draft changes and leave the profile policy file unchanged.

## Settings hub

`/zenmoney` should open a single hub that exposes profile selection, account selection, snapshot-path setup, and balance reporting without forcing the user into separate commands.

## Hub balance display

Opening `/zenmoney` should show the current entity balance inline by default, and the displayed totals should update when profile or account selections change.

## Clear spending classification

Transaction summaries should count only `outcome` rows as clear spending, so transfers and hold rows do not inflate expense totals.

## Active profile resolution

When no entity is passed, the balance and transaction tools should use the workspace's active profile instead of falling back blindly to `default`.

## Snapshot path editing

Editing the hub's snapshot path should preserve relative-path validation and fall back to the entity snapshot folder when the field is reset.

## Profile enter flow

Enter or Return should move from profiles into accounts or create a new draft profile when the search text does not match an existing entity, then save selected account ids from the account pane.
