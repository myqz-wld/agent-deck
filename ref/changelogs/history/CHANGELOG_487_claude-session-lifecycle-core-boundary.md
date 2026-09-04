---
changelog_id: 487
changed_at: 2026-08-05
---

# CHANGELOG_487_claude-session-lifecycle-core-boundary: Port close and mode state

## Summary

Claude live-session lookup, close/rollback ordering, handoff retirement, and permission-mode
serialization no longer own the desktop repository, cleanup implementation, or logger. A
host-neutral Core owns the lifecycle state machine while a desktop host performs side effects.

## Host-neutral lifecycle Core

- Added `session-lifecycle-core.ts` with map/application/CLI identity resolution, interrupts,
  bounded one-second stream drain, ordinary close, and strict rollback close.
- Preserved the strict invariant that rollback cleanup releases ownership only after stream
  termination is independently proven; timeout restores the prior expected-close state.
- Moved handoff input sealing and per-session permission-mode promise chaining/rollback into Core.

## Thin desktop host and facade

- Added `session-lifecycle-host.ts` as the sole owner of pending cleanup, persisted-session existence
  checks, and lifecycle diagnostics.
- Reduced the stable lifecycle module to typed compatibility wrappers over Core and Host.
- Preserved dormant permission updates as no-op success and missing-session updates as failures.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, pending cleanup, bridge
  session types, event/runtime/session/store utilities, Node built-ins, Electron, and electron-log
  from Core.
- Added Claude session lifecycle Core as the fifty-second executable Node 22 boundary candidate.

## Validation

- Focused Core/host, strict rollback close, and real bridge permission-mode coverage: passed,
  4 files / 16 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 671 files / 4,882 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the lifecycle Core, desktop host, stable facade, strict close and permission concurrency tests,
direct-import rule, and bundle candidate together. Strict rollback must never release ownership
before the provider stream drain proves termination.

## Remaining boundary

Claude live-session lifecycle policy is now host neutral. Pending cleanup implementation, larger
create/recovery orchestration, and real Linux/SSH/Feishu/provider acceptance remain.
