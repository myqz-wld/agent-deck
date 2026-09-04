---
changelog_id: 484
changed_at: 2026-08-05
---

# CHANGELOG_484_claude-live-token-rate-host-boundary: Port decode-rate state to Core

## Summary

Claude SDK live token-rate estimation no longer reads the desktop session repository or publishes
directly to the application event bus. A host-neutral Core owns streaming decode segments and final
rate calibration while one desktop host resolves models and emits display ticks.

## Host-neutral decode-rate Core

- Added `live-token-rate-core.ts` with stream-message parsing, CJK/non-CJK token estimation, first
  delta anchoring, 250 ms throttling, EMA smoothing, and authoritative final output calibration.
- Preserved multiple assistant decode segments while excluding tool-wait gaps from elapsed time.
- Preserved `message_start` and final result model overrides, `claude-default` fallback, terminal
  cleanup, and display-only failure isolation.

## Thin desktop host and facade

- Added `live-token-rate-host.ts` as the sole owner of `sessionRepo` lookup precedence and
  `token-rate-tick` event-bus publication.
- Kept the stable stream handler, completion, clear, token-estimator exports, and optional clock
  arguments unchanged.
- Moved the display-only live state contract into Core and retained a type-only compatibility export
  from the existing Claude bridge types module.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, bridge session types, event
  bus, runtime/session/store utilities, Node built-ins, Electron, and electron-log from Core.
- Added the Claude live token-rate Core as the forty-ninth executable Node 22 boundary candidate.

## Validation

- Focused Claude Core, host, stable facade, and final usage translation coverage: passed,
  4 files / 30 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-nine Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 665 files / 4,873 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the decode-rate Core, desktop host, stable facade, state type bridge, direct regressions, import
rule, and bundle candidate together. Decode windows must remain provider-neutral display state and
must not move back into the desktop repository or event bus.

## Remaining boundary

All three live provider rate paths are now host neutral. Broader provider/repository seams and real
Linux/SSH/Feishu/provider acceptance remain.
