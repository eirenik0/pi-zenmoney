# pi-zenmoney

ZenMoney Pi package for account discovery, transaction export, and entity-scoped balance snapshots.

## Use cases

- `/zenmoney` — open the ZenMoney settings hub for profiles, accounts, snapshot-path setup, and an inline balance summary.
- `/zen-transactions <selector[,selector...]> [YYYY-MM]` — export transactions for selected accounts.

## Install

```bash
npm install pi-zenmoney
pi install pi-zenmoney
```

Local development:

```bash
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
- `ZENMONEY_SNAPSHOT_SELECTORS` — fallback selectors for balance workflows when none are passed
- `ZENMONEY_SNAPSHOT_PATH` — fallback relative snapshot folder, resolved in the working files folder
- `.pi/zenmoney/config.json` — optional workspace config for the active entity
- `.pi/zenmoney/entities/<entity>/policy.json` — optional per-entity `selectors` and `snapshot_path` used by `/zenmoney`
- `.pi/zenmoney/entities/<entity>/registry.json` — cached live snapshot for analysis on top of the registry

## Release notes

Release entries are tracked in `CHANGELOG.md`.

## Publishing

GitHub Actions publishes the package from semver tags like `v0.1.0`.
The workflow expects an `NPM_TOKEN` secret and skips republishing versions
that already exist on npm.

## ZenMoney API

This extension is built on the official ZenMoney API:

- https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API

If you only need an API token, the ZenMoney wiki notes that you can get one without registering a new service, by using a previously registered ZenMoney service. For example: [Zerro.app](https://zerro.app/token).

## Notes

- Project-local extension entrypoint: `src/index.ts`
- Extension logic: `src/zenmoney.ts`, `src/hub.ts`
- Secret reference helper: `src/secret-refs.ts`
- Entity snapshots default to `.pi/zenmoney/entities/<entity>/snapshots/` unless overridden by a relative path
