# pi-zenmoney

ZenMoney Pi package for account discovery, transaction export, personal balance snapshots, and personal register generation.

## Use cases

- `/zen-accounts [query]` — list ZenMoney accounts for explicit selection.
- `/zen-transactions <selector[,selector...]> [YYYY-MM]` — export transactions for selected accounts.
- `/zen-personal-balance <selector[,selector...]> [YYYY-MM] [--store]` — summarize personal balances and monthly totals; `--save` also works.
- `/zen-personal-register <YYYY-MM> [--write] [selector[,selector...]]` — preview or write the canonical personal JSONL register.

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
- `ZENMONEY_PERSONAL_SELECTORS` — fallback selectors for `/zen-personal-balance` when none are passed

## Notes

- Project-local extension entrypoint: `src/index.ts`
- Extension logic: `src/zenmoney.ts`
- Secret reference helper: `src/secret-refs.ts`
