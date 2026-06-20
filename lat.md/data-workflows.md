# Data Workflows

This section covers entity-scoped ZenMoney snapshot exports and local snapshot persistence under `ZenMoney/Entities/<entity>/Snapshots`.

## ZenMoney Entity Snapshots

Each entity resolves selectors from explicit args, its entity policy `selectors`, or `ZENMONEY_SNAPSHOT_SELECTORS` before writing JSON and CSV snapshots, with `default` as the implicit scope.

Snapshot storage uses a relative base path from explicit args, entity policy `snapshot_path`, `ZENMONEY_SNAPSHOT_PATH`, or the default `ZenMoney/Entities/<entity>/Snapshots` folder.

Key code paths: [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]], [[src/zenmoney.ts#storeZenMoneyBalanceSnapshot]].
