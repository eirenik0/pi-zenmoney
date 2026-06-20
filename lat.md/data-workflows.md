# Data Workflows

This section covers ZenMoney workspace-scoped entity policies, registry snapshots, and local exports under `.pi/zenmoney/entities/<entity>/`.

## ZenMoney Entity Snapshots

Each entity resolves selectors from explicit args, its entity policy `selectors`, or `ZENMONEY_SNAPSHOT_SELECTORS` before writing JSON and CSV snapshots, with `default` as the implicit scope.

The profile editor writes selected account ids back to `.pi/zenmoney/entities/<entity>/policy.json` and keeps any stored snapshot path intact.

The latest live ZenMoney snapshot is cached as `.pi/zenmoney/entities/<entity>/registry.json` for working-memory analysis.

Snapshot storage uses a relative base path from explicit args, entity policy `snapshot_path`, `ZENMONEY_SNAPSHOT_PATH`, or the default `.pi/zenmoney/entities/<entity>/snapshots/` folder.

Key code paths: [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]], [[src/zenmoney.ts#storeZenMoneyBalanceSnapshot]].
