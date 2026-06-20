# pi-zenmoney

ZenMoney Pi package for account discovery, transaction export, and entity-scoped balance snapshots.

## Use cases

- `/zen-accounts [query]` — list ZenMoney accounts for explicit selection; archived accounts are hidden by default.
- `/zenmoney` — open the ZenMoney settings hub for profiles, accounts, snapshot-path setup, and an inline balance summary.
- `/zen-profiles` — legacy alias for profile/account editing; typing a new name lets you create a profile.
- `/zen-transactions <selector[,selector...]> [YYYY-MM]` — export transactions for selected accounts.
- `/zen-balance [--entity <name>] [--snapshot-path <relative/path>] [selector[,selector...]] [YYYY-MM] [--store]` — summarize balances and monthly totals; `--save` also works.

## Install

```bash
npm install
pi install /absolute/path/to/this/repo
```

Git install:

```bash
pi install git:github.com/eirenik0/pi-zenmoney
```

Reload Pi or restart after installing.

## Environment

Set:

- `ZENMONEY_TOKEN`

The token may be a raw token, an `op://` 1Password reference, `op read ...`, or `$(op read ...)`.

Optional:

- `ZENMONEY_API_BASE_URL`
- `ZENMONEY_SNAPSHOT_SELECTORS` — fallback selectors for `/zen-balance` when none are passed
- `ZENMONEY_SNAPSHOT_PATH` — fallback relative snapshot folder, resolved in the working files folder
- `ZenMoney/Entities/<entity>/entity-policy.json` — optional per-entity `selectors` and `snapshot_path` used by `/zen-profiles`

## ZenMoney API

This extension is built on the official ZenMoney API:

- https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API

If you only need an API token, the ZenMoney wiki notes that you can get one without registering a new service, by using a previously registered ZenMoney service. For example: [Zerro.app](https://zerro.app/token).

## Notes

- Project-local extension entrypoint: `src/index.ts`
- Extension logic: `src/zenmoney.ts`, `src/hub.ts`
- Secret reference helper: `src/secret-refs.ts`
- Entity snapshots default to `ZenMoney/Entities/<entity>/Snapshots/` unless overridden by a relative path
