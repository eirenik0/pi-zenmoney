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
