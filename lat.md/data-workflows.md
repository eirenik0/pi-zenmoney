# Data Workflows

This section covers the universal ZenMoney data workflows used by the extension, especially register generation and local snapshot persistence under `ZenMoney/Registers` and `ZenMoney/Snapshots`.

## ZenMoney Transaction Register

The register stores one JSONL row per account-side transaction, merges new data by row id, and preserves manual classification fields when updating existing rows.

Key code paths: [[src/zenmoney.ts#prepareZenMoneyRegister]], [[src/zenmoney.ts#buildZenMoneyRegisterRows]], [[src/zenmoney.ts#mergeZenMoneyRegisterRows]], [[src/zenmoney.ts#classifyZenMoneyRegisterRow]].
