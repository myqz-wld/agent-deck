---
changelog_id: 465
changed_at: 2026-08-05
---

# CHANGELOG_465_storage-maintenance-worker-host-boundary: Port maintenance worker construction

## Summary

The storage maintenance scheduler no longer imports Electron-Vite's `?nodeWorker` transform,
discovers the process database, or logs through the desktop logger. Production composition now
belongs to an explicit desktop host, and the scheduler is an executable Node 22 boundary candidate.

## Explicit scheduler host

- Moved the `?nodeWorker` transform, fixed worker name, authoritative database lookup, clock, and
  desktop diagnostic logger into `scheduler-host.ts`.
- Made the host-neutral scheduler fail closed before mutating lifecycle state when no host is
  supplied; desktop bootstrap now constructs it through the explicit host factory.
- Ported lifecycle messages behind a semantic diagnostics interface with a no-op core default and a
  desktop logger adapter, retaining slow-slice/checkpoint throttling and all prior messages.
- Preserved ready/close correlation, stale-generation fencing, one in-flight request, WAL lease
  rollback, timeout terminal-disable policy, respawn bounds, and shutdown settlement.

## Executable boundary gate

- Added a direct-import rule rejecting the database singleton, desktop worker host, transform, and
  desktop utilities from the host-neutral scheduler.
- Added the storage maintenance scheduler as the thirtieth executable Node 22 bundle candidate.
- Added regressions proving unconfigured construction fails closed and remains retryable, desktop
  worker identity is exact, and semantic lifecycle diagnostics still reach the logger adapter.

## Validation

- Canonical Electron storage-maintenance coverage: passed, 6 files / 20 tests.
- Bootstrap composition coverage remained green in the initial focused 4 files / 17 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed; the maintenance worker remains a separate production chunk.
- Canonical Electron full suite: passed, 631 files / 4,821 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; 117 structured changelogs, maximum id 465.

## Do Not Split Protection

Keep the host-neutral scheduler/diagnostics port, desktop DB/worker/logger adapter, bootstrap factory,
fail-closed and exact-identity tests, direct-import rule, and executable bundle gate together. The
scheduler must not regain implicit desktop database, transform, or logging dependencies.

## Remaining boundary

All three known Electron-Vite Node-worker transforms now live only in desktop host adapters. The
larger concrete Core still needs provider settings/composition, Browser registry ownership,
authoritative repository composition, and real Linux/provider acceptance. No shared development or
Electron process was started, restarted, stopped, or killed.
