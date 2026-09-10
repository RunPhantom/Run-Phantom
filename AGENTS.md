# Agent guide

This repository is Run Phantom, a source-first local debugger for AI-agent
runs. The repo is intended for development, verification, and packaging work
against the current source tree.

Run Phantom is owned and maintained by Divyam Talwar, who holds all rights in
the software. It is released under the MIT terms in `LICENSE`.

## If you are using the app

Build and run it locally:

```bash
bun install
bun run dev
```

The daemon listens on `:5947` and the Vite UI serves on `:5948` by default.

## If you are developing the repo

Use the root commands:

```bash
bun run build
bun run test
bun run lint
bun x tsc --noEmit
```

## Working rules

- Touch only what the task requires.
- Keep changes scoped and reversible.
- Do not add new dependencies without a strong reason.
- Preserve the MIT notice in `LICENSE`.
- Keep comments only when they explain non-obvious behavior or constraints.

## Do not touch without explicit permission

- `.github/workflows/`
- release or publish configuration

## Verification

Before considering a change complete, run the relevant build, test, lint, and
typecheck commands and confirm the UI still boots.
