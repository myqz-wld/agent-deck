---
changelog_id: 483
changed_at: 2026-08-05
---

# CHANGELOG_483_codex-live-token-rate-host-boundary: Port Codex live usage state

## Summary

Codex app-server live token-rate observation no longer reads the desktop session repository or
publishes directly to the application event bus. A host-neutral Core owns usage watermarks and rate
state while one desktop host resolves models and emits display events.

## Host-neutral usage Core

- Added `live-token-rate-core.ts` with turn arming, cumulative usage observation, native-thread
  fingerprinting, replay suppression, output-delta rate calculation, and terminal display cleanup.
- Preserved the 250 ms elapsed-time floor, reasoning-token subset rule, zero-delta anchor advance,
  transient-error retention, and fatal/completed clear behavior.
- Kept all display tracking fail-isolated so model lookup or event publication cannot interrupt the
  app-server notification translator.

## Thin desktop host and facade

- Added `live-token-rate-host.ts` as the sole owner of `sessionRepo` lookup precedence and
  `token-rate-tick` event-bus publication.
- Kept the stable facade's real app-server notification and `InternalSession` signatures unchanged.
- Moved the display-only state contract into Core and retained a type-only compatibility export from
  the existing bridge types module.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, bridge session types,
  app-server client, event bus, runtime/session/store utilities, Node built-ins, Electron, and
  electron-log from Core.
- Added the Codex live token-rate Core as the forty-eighth executable Node 22 boundary candidate.

## Validation

- Focused Codex Core, host, and compatibility-facade coverage: passed, 3 files / 9 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-eight Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full-suite rerun: passed, 663 files / 4,870 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the usage Core, desktop host, stable facade, state type bridge, direct regressions, import rule,
and bundle candidate together. Cumulative watermarks must remain thread-lifetime Core state and must
not move into the desktop repository or event bus.

## Remaining boundary

Codex live usage observation is now host neutral. Claude live-rate observation, broader provider and
repository seams, and real Linux/SSH/Feishu/provider acceptance remain.
