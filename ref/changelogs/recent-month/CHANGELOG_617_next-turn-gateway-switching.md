---
changelog_id: 617
changed_at: 2026-08-17
---

# CHANGELOG_617_next-turn-gateway-switching: Apply Gateway changes on the next turn

## Summary

Gateway controls are now choice-only, and a Codex Gateway selected during an active response is
saved without interrupting that response. Agent Deck applies the complete selected configuration
to the same Codex thread before its next turn.

## Changes

### Choice-only Gateway controls

- Replaced free-text Gateway mutation with a read-only combobox backed only by discovered Claude
  or Codex Gateway files, plus the empty native-configuration choice.
- Applied the closed catalog to local and Remote session creation, handoff, live runtime controls,
  generator settings, and bundled-Agent runtime overrides.
- Made Server Core advertise Gateway catalogs as non-custom and reject unadvertised selections at
  its authoritative validation boundary.

### Deferred Codex Gateway switching

- Let the shared session-model controller opt Codex into active-turn Gateway staging while keeping
  the existing active-turn rejection boundary for adapters that cannot stage a switch.
- Persist and validate the requested Gateway immediately, but leave the in-flight Codex turn on
  its original runtime configuration.
- Stage the complete Gateway TOML layer, native `modelProvider`, model, and reasoning effort, then
  issue `thread/resume` before the next `turn/start` on the same thread.
- Fold later model or reasoning edits into the staged boundary and serialize configuration
  revisions so a stale readiness attempt cannot win over a newer selection.

### User-facing errors and recovery

- Replaced `profile` / `provider` implementation terminology in Gateway selection errors with
  concise Simplified Chinese model-Gateway copy.
- Strip Electron IPC transport wrappers before rendering runtime-setting failures.
- Restore the last authoritative model selection after a failed write so later edits are not
  trapped behind a rejected Gateway draft.
- Updated the runtime help text and README to state that Gateway, model, and thinking changes leave
  the current response untouched and take effect from the next turn.

## Validation

- Focused Gateway controller, app-server, bridge, renderer, Server Core, error-copy, and parser
  coverage: 11 files / 96 tests passed.
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Prompt-asset inventory, README backup manifest and original hash, refreshed README hash,
  counterpart checks, and local Markdown links validated.
- `git diff --check`

## Do Not Split Protection

All changed production TypeScript files remain at or below 500 lines. Gateway readiness was
extracted into `thread-readiness.ts`, leaving the Codex bridge facade at 495 lines and the app-server
thread at 470 lines.

## Notes

The confirmed README asset was backed up before editing under
`.prompt-asset-improver/local/backups/20260817T114329Z/`. Restore it by copying the manifest-named
backup over `README.md`.

The automatic development restart was not continued after the user explicitly requested that no
processes be killed. The installed Agent Deck app remained available on `127.0.0.1:47821` at final
verification.
