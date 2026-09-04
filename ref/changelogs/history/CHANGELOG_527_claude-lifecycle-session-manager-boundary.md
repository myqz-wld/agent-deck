---
changelog_id: 527
changed_at: 2026-08-05
---

# CHANGELOG_527_claude-lifecycle-session-manager-boundary: Inject Claude lifecycle ownership

## Summary

Claude pending cancellation, close/rollback cleanup, and create-session final persistence no longer
import the desktop SessionManager singleton. They now receive the same adapter-owned manager port
used by create, recovery, and stream identity handling.

## Lifecycle ownership injection

- Extended the Claude manager port with `markRecentlyDeleted`, preserving the optional native-id
  argument and exact facade delegation.
- Replaced pending-cancellation, session-lifecycle, and session-finalize singleton hosts with
  factories over minimal manager subsets.
- Passed the manager port through interrupt, permanent close, strict rollback close, permission
  updates, pending cleanup, and every create-session finalize path.
- Kept repository persistence, event publication, sandbox cleanup, clock, and diagnostics in their
  existing desktop hosts; only SessionManager ownership moved behind the port.

## Preserved ordering and failure authority

- Strict rollback still waits for independent stream-drain proof before releasing any SDK claim.
- Permanent close still interrupts, resolves all pending authority, clears queues and private
  settings, removes the live map entry, releases each unique identity, marks deletion when enabled,
  wakes waiters, and only then joins the bounded stream drain.
- Initial session registration still emits the session-start row before settling the spawn
  reservation, and later native-id persistence remains best-effort without replacing provider
  startup authority.
- Permission-mode-only operations still reuse the lifecycle host but cannot trigger cleanup.

## Direct evidence and architecture gate

- Updated host delegation tests to prove the injected manager object is the one used for cleanup,
  claim release, deletion marking, and CLI-id persistence.
- Retained strict-close tests for pre-drain ownership, bounded timeout rollback, interrupt failure,
  and missing-runtime rejection.
- Added static rules rejecting future direct SessionManager imports from all three lifecycle hosts.
- Reused the existing eighty-eighth Node 22 manager-port candidate; no second bundle was added.

## Validation

- Focused lifecycle/create coverage: passed, 12 files / 45 tests.
- Complete Claude adapter coverage: passed, 114 files / 484 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 726 files / 5,016 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains at 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the manager-port extension, lifecycle host factories, facade arguments, bridge/create bindings,
tests, and architecture rules together. Partial injection could release or blacklist a session
through a different manager instance from the one that owns its create/recovery claim.

## Remaining boundary

The background/live Claude usage snapshot host is now the only production Claude host outside the
adapter composition root that imports SessionManager directly. The next slice should inject its
read-only session lookup without changing quota fallback or live-query preference.
