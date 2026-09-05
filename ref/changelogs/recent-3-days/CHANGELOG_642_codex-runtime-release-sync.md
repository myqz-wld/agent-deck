---
changelog_id: 642
changed_at: 2026-09-05
---

# Codex Runtime Release Sync

## Summary

Upgrade the embedded Codex CLI from `0.153.2` to stable `0.153.4` and prepare an updated macOS app.

## Changes

- Raise `@openai/codex` to `^0.153.4` in `package.json` and lock `0.153.4`, including all six
  native platform aliases, in `pnpm-lock.yaml`. Other dependencies retain their existing versions.
- Document the bundled version and rebuild/reinstall requirement in the README Quick Start section.
- Keep the existing application and Worker binary resolution and packaging contracts.
- Recompute changelog date buckets and move changelog 565 into the inclusive 30-day bucket.

## Validation

- npm registry stable tag and official release metadata checked.
- `pnpm update @openai/codex@^0.153.4 --ignore-scripts` completed.
- `pnpm exec codex --version` reports `codex-cli 0.153.4`.
- A real Codex app-server accepted the application's initialize payload with an isolated temporary
  `CODEX_HOME`, reported `agent-deck/0.153.4`, and exited cleanly when stdin closed.
- `pnpm typecheck` passed, including architecture checks.
- `pnpm test`: 1,025 files and 6,346 tests passed; 2 files and 3 opt-in tests skipped. Tests used
  the Electron-compatible runner without swapping the SQLite binding.
- README local links, backup hash, refreshed prompt inventory hash, and `git diff --check` passed.
- `pnpm dist:mac` passed, including the production build and both source and packaged macOS Worker
  sandbox checks. The arm64 application and DMG are available under `build/dist/`.
- Both the packaged application Codex binary and the packaged Worker Codex binary report
  `codex-cli 0.153.4`. The currently installed app still reports `codex-cli 0.153.2`.

## Do Not Split Protection

No production source files changed. The dependency lockfile is exempt from the file-size guardrail.

## Notes

- Release: https://github.com/openai/codex/releases/tag/rust-v0.153.4
- The user requested commit and push while keeping Agent Deck running. The installed app remains
  unchanged; installation and restart are deferred.
- README documentation is within the requested dependency upgrade and the required matching
  documentation scope. The local prompt-asset inventory and timestamped backup record the original
  and final hashes; restoring the backed-up README restores its original content. Bundled
  Claude/Codex application conventions were not changed.
