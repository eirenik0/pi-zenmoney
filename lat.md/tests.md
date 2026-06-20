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

## Command and tool parity

`/zen-balance` and `zenmoney_balance` should agree on entity scoping, snapshot path handling, and stored output shape.

## Profile browsing

The interactive editor should list available profiles, hide archived accounts by default, show the selected profile's current accounts, and keep navigation stable when the profile list changes.

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

## Profile enter flow

Enter or Return should move from profiles into accounts and save selected account ids from the account pane.
