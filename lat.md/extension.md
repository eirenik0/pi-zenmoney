# Extension

This section describes the ZenMoney Pi extension surface and the user-facing data it exposes to Pi.

## ZenMoney Live Bank Data

The extension turns ZenMoney API data into selectable account listings, normalized transaction exports, entity-scoped balance snapshot reports, and an interactive profile editor for the Pi UI, keyed by `--entity` or the default scope.

`/zen-profiles` opens the profile editor with separate live search filtering for profiles and accounts, hiding archived accounts by default; the balance command and tool both accept `--snapshot-path` / `snapshotPath`, and the value must stay relative to the working files folder.

Key code paths: [[src/zenmoney.ts#registerZenMoneyExtension]], [[src/zenmoney.ts#listZenMoneyAccounts]], [[src/zenmoney.ts#readZenMoneyTransactions]], [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]], [[src/zenmoney.ts#storeZenMoneyBalanceSnapshot]].
