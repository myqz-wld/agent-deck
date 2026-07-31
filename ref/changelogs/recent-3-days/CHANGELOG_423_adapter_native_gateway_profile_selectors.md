---
changelog_id: 423
changed_at: 2026-07-31
---

# CHANGELOG_423_adapter_native_gateway_profile_selectors: Native Gateway and profile selectors

## Summary

Session creation now names each adapter's runtime selector by its native concept: Claude Code uses
`gateway`, Codex CLI uses `profile`, and Grok Build exposes neither. Codex profiles are independent
read-only `$CODEX_HOME/<name>.config.toml` files selected when starting app-server.

## Changes

### Codex native profiles

- Discover safe `*.config.toml` profile files under `$CODEX_HOME` without creating or modifying
  them.
- Start a selected session runtime as
  `codex --profile <name> app-server --stdio`.
- Keep one-shot, recovery, resume, fork, defaults, and live profile switching on the same
  process-level profile.
- Stop promoting a custom Agent TOML `model_provider` value into the app-server process selector;
  it remains part of that Agent's native configuration layer.

### Adapter-owned naming

- Rename Claude adapter create/recovery/fork fields to `gateway`.
- Rename Codex adapter process fields to `profile`.
- Expose `gateway` and `profile` separately in `spawn_session`, `hand_off_session`, session
  projections, and success results; reject adapter-incompatible or retired `provider` selector
  input.
- Replace CLI `--provider` with Claude `--gateway` and Codex `--profile`.
- Keep the existing generic database `runtime_provider` column and shared UI storage as
  compatibility boundaries while mapping immediately to the adapter-native field.

### UI and resources

- Discover Codex native profiles through the read-only Assets IPC and label Codex controls
  “Profile”; Claude controls remain “Gateway”.
- Align bundled Claude and Codex runtime instructions with `gateway?` / `profile?` ownership and
  native Codex app-server startup.

## Validation

- Targeted adapter, profile, CLI, hand-off, and MCP suites: 30 files / 403 tests passed.
- Targeted renderer, IPC, and bundled-runtime suites: 11 files / 101 tests passed.
- `pnpm typecheck`.
- `env NODE_ENV=test pnpm test` (480 files passed, 1 skipped; 3,931 tests passed,
  1 skipped).
- `git diff --check`.

## Do Not Split Protection

Two pre-existing adapter facades remain just over the guardrail:
`src/main/adapters/claude-code/sdk-bridge/index.ts` (506 lines) and
`src/main/adapters/codex-cli/sdk-bridge/index.ts` (514 lines). This change only updates their thin
runtime-selector mappings; splitting either lifecycle facade would expand scope and risk unrelated
session behavior. Revisit when either facade next receives a substantive lifecycle feature.

## Notes

- Existing persisted selector ids remain usable because storage stays in `runtime_provider`.
- A missing Codex profile fails before session mutation and leaves the prior live selection intact.
- Main/preload IPC changes require restarting Agent Deck before the new profile discovery API is
  available in an already-running app.
