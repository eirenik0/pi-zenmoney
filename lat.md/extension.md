# Extension

This section describes the ZenMoney Pi extension surface and the user-facing data it exposes to Pi.

## ZenMoney Live Bank Data

The extension turns ZenMoney API data into selectable account listings, normalized transaction exports, entity-scoped balance snapshot reports, and a unified settings hub for the Pi UI, keyed by `--entity` or the default scope.

`/zenmoney` opens the settings hub for profiles, accounts, snapshot-path setup, and an inline balance summary. Archived accounts stay hidden by default, and the balance workflow and tool both accept `--snapshot-path` / `snapshotPath`, which must stay relative to the working files folder. The latest live snapshot is cached per entity in `.pi/zenmoney/entities/<entity>/registry.json`.

Key code paths: [[src/zenmoney.ts#registerZenMoneyExtension]], [[src/hub.ts#ZenMoneyHubEditor]], [[src/zenmoney.ts#readZenMoneyTransactions]], [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]], [[src/zenmoney.ts#storeZenMoneyBalanceSnapshot]].
