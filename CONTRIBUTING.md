# Contributing

Bug reports and small pull requests are welcome. For anything larger, open an issue first so we can agree on it.

## Setup

You need Node.js 24 or later and Git. Development happens on Windows.

```bash
npm ci
npm run dev
```

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run test:e2e
```

## Rules that matter

- **RepoLantern never runs code from the repositories it opens.** No scripts, hooks or project binaries. Reading files and running `git` are the only access. When looking for a tool on the system, search from outside the repository.
- **Never read secret values.** Respect the exclusions in `src/main/scansione.ts`.
- **The core works without AI and without an account.** Anything that needs a model stays optional.
- **Say what you know and how.** If a result is a guess, label it as a guess.
- **Every visible string goes through `t()`**, with the key in both `src/shared/en.ts` and `src/shared/it.ts`.

## Good to know

The code began as a personal tool, so identifiers, comments and test names are mostly in Italian. New code can be in English.
