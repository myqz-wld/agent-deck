---
changelog_id: 488
changed_at: 2026-08-05
---

# CHANGELOG_488_claude-pending-cancellation-core-boundary: Port close cleanup state

## Summary

Claude pending-request cancellation and close-session cleanup no longer own the desktop session
manager, Gateway temporary-settings cleanup, or wall clock. A host-neutral Core owns the cleanup
state machine while a desktop host performs those external side effects.

## Host-neutral cleanup Core

- Added `pending-cancellation-core.ts` with permission, ask-question, and exit-plan cancellation
  events, timer retirement, resolver settlement, and exact pending-map clearing.
- Preserved the application-session identity used by cancellation events and the existing
  permission-deny, session-ended answer, and keep-planning settlement values.
- Moved queued/submitting message cleanup, bounded tombstone clearing, exact session-map removal,
  distinct application/native claim retirement, optional recently-deleted fencing, and best-effort
  stream wakeup into Core.

## Thin desktop host and facade

- Added `pending-cancellation-host.ts` as the sole owner of wall-clock reads, Gateway sandbox
  temporary-settings cleanup, SDK claim release, and recently-deleted session state.
- Reduced the stable pending-cancellation module to typed compatibility wrappers over Core and
  Host, with no call-site or public-signature change.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop hosts, bridge session types,
  Gateway cleanup implementation, runtime/session/store utilities, Node built-ins, Electron, and
  electron-log from Core.
- Added Claude pending cancellation Core as the fifty-third executable Node 22 boundary candidate.

## Validation

- Focused Core/host, stable facade, and session-lifecycle coverage: passed, 5 files / 15 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 672 files / 4,886 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the cancellation Core, desktop host, stable facade, lifecycle caller, direct-import rule, and
resolver/identity/wakeup tests together. Closing must cancel all three pending kinds before clearing
their maps, release every distinct identity, and wake the input stream only after ownership removal.

## Remaining boundary

Claude pending cancellation and close cleanup policy are now host neutral. Larger stream processing,
create/recovery orchestration, and real Linux/SSH/Feishu/provider acceptance remain.
