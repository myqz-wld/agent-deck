---
changelog_id: 583
changed_at: 2026-08-10
---

# CHANGELOG_583_local-macos-install: Automate local macOS installation

## Summary

The macOS local-install workflow now packages, validates, and replaces Agent Deck through one
rollback-safe command, then removes the unpacked build copy so macOS does not index two apps with
the same name and bundle identifier.

## Changes

- Added `pnpm install:local:mac` to run the native macOS packaging checks before stopping the
  installed app and replacing it through hidden staging and backup bundles.
- Reuse an already-correct root-owned CLI symlink, validate the ad-hoc signature and installed
  build metadata, and restore the previous app when validation fails.
- Remove `build/dist/mac-*/Agent Deck.app` only after successful installation while preserving the
  DMG and block map.
- Documented the canonical command and its package-only boundary for requests that prohibit
  stopping the running app.

## Validation

- `node --test scripts/install-local-macos.test.mjs`
- `pnpm typecheck`
- `pnpm test`
- `pnpm install:local:mac`
- `agent-deck --check-installed`
- `git diff --check`

## Do Not Split Protection

No changed source file exceeds 500 lines. The installer keeps its rollback, symlink, validation,
and duplicate-cleanup operations together as one bounded macOS workflow.
