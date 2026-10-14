# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

Pending changes will be listed here.

## 0.2.0 (2026-10-14)

- Time out ZenMoney API and 1Password lookups, and cancel a loading command with Esc.

## 0.1.1 (2026-06-20)

- Restore the missing selector slug helper so `zenmoney_balance --store` can write snapshot files.

## 0.1.0 (2026-06-20)

Initial public release of the ZenMoney Pi extension.

- `/zenmoney` settings hub for profiles, accounts, archived-account toggling, balance, and snapshot-path editing.
- `/zen-transactions` for normalized transaction exports.
- Workspace-scoped ZenMoney policy and registry storage under `.pi/zenmoney/`.
- Profile deletion for non-default entities.
