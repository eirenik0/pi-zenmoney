# Extension

This section describes the ZenMoney Pi extension surface and the user-facing data it exposes to Pi.

## ZenMoney Live Bank Data

The extension turns ZenMoney API data into selectable account listings, normalized transaction exports, and renderable reports for the Pi UI.

Key code paths: [[src/zenmoney.ts#registerZenMoneyExtension]], [[src/zenmoney.ts#listZenMoneyAccounts]], [[src/zenmoney.ts#readZenMoneyTransactions]], [[src/zenmoney.ts#readZenMoneyBalanceSnapshot]].
