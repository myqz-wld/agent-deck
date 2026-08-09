---
changelog_id: 482
changed_at: 2026-08-05
---

# CHANGELOG_482_grok-live-token-rate-observer-boundary: Port live rate state to Core

## Summary

Grok streaming token-rate estimation and completion reconciliation no longer depend on the desktop
event bus. A host-neutral Core owns the live state machine while one desktop observer publishes the
typed display event.

## Host-neutral live-rate Core

- Added `live-token-rate-core.ts` with stream state initialization, first-chunk exclusion, bounded
  250 ms flushing, EMA smoothing, CJK/non-CJK token estimation, and authoritative completion-rate
  reconciliation.
- Preserved API-reported duration precedence over observed stream timing and the existing invalid
  completion clear behavior.
- Kept display cleanup idempotent by emitting the terminal zero-rate tick only while live state
  exists.

## Thin desktop observer

- Added `live-token-rate-host.ts` as the sole owner of `eventBus` publication.
- Kept the stable `live-token-rate.ts` API as a compatibility facade with the same optional clock
  arguments and return values.
- Added direct Core observer tests and a host wiring test alongside the existing rate regressions.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop observer, event bus, provider
  runtime/session/store utilities, Node built-ins, Electron, and electron-log from Core.
- Added the Grok live token-rate Core as the forty-seventh executable Node 22 boundary candidate.

## Validation

- Focused Grok live-rate, translation, and usage coverage: passed, 5 files / 45 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-seven Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 661 files / 4,867 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the live-rate Core, desktop observer, compatibility facade, observer regressions, direct-import
rule, and bundle candidate together. Token-rate state must not move back into the application event
bus or provider transport lifecycle.

## Remaining boundary

Grok live display-rate state is now host neutral. Broader provider/repository seams and real
Linux/SSH/Feishu/provider acceptance remain.
