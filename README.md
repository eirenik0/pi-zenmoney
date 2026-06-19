# pi-zenmoney-extension

A Pi package that provides the ZenMoney extension.

## Install

```bash
npm install
pi install /absolute/path/to/this/repo
```

For git-hosted installs, use:

```bash
pi install git:github.com/you/pi-zenmoney-extension@v1
```

Or add the repo path to `.pi/settings.json` as a local package.

Reload Pi or restart after installing.

## Loaded extension

- `src/index.ts`
- `src/zenmoney.ts`
- `src/secret-refs.ts`

## Commands

- `/zen-accounts`
- `/zen-transactions`
- `/zen-personal-balance`
- `/zen-personal-register`

## Environment

Set one of:

- `ZENMONEY_ACCESS_TOKEN`
- `ZENMONEY_TOKEN`

Optional:

- `ZENMONEY_API_BASE_URL`

The token may also be a 1Password `op://` reference.
