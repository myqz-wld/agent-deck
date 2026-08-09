---
changelog_id: 525
changed_at: 2026-08-05
---

# CHANGELOG_525_claude-recovery-session-manager-boundary: Inject Claude recovery ownership

## Summary

Claude recovery no longer imports the desktop SessionManager singleton. Close-epoch fencing,
closed-session restoration, and archived-session reactivation now use the same manager port that
adapter construction already supplies to create-session and native-fork rollback.

## Recovery ownership injection

- Extended the Claude manager port with `getCloseEpoch`, `markClosed`, and `unarchive` while
  preserving exact arguments and `unarchive` promise identity.
- Added the injected recovery subset to `RecovererCtx` and passed the bridge-owned port into each
  `SessionRecoverer`.
- Replaced every direct recovery singleton call: baseline capture, post-await cancellation checks,
  cwd-failure closed restoration, archive reactivation, and terminal failure restoration.

## Preserved races and authority

- The close-epoch baseline remains captured after the initial visible event, so only a new close or
  deletion during recovery cancels the attempt.
- The recovery single-flight lock still covers unarchive and every later await.
- Closed rows still return to closed after cwd or create failure, while dormant and archived resume
  semantics remain unchanged.
- Provider/create failures remain authoritative; manager restoration does not replace their error.

## Direct evidence and architecture gate

- Expanded the port test to cover close-epoch reads, close restoration, archive restoration, and
  promise identity.
- Added a static rule rejecting future direct SessionManager imports from the recovery implementation.
- Reused and strengthened the existing eighty-eighth Node 22 manager-port candidate; this slice did
  not introduce a redundant second candidate.

## Validation

- Recovery, JSONL fallback, restart precheck, and port coverage: passed, 4 files / 58 tests.
- Complete Claude adapter coverage: passed, 113 files / 483 tests.
- Node TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 725 files / 5,015 tests plus 1 skipped.
- `recover-and-send-impl.ts` remains below the line ceiling; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the expanded port, recoverer context, bridge binding, implementation replacements, tests, and
static rule together. A partial change could compare close epochs or restore lifecycle state through
a different manager instance than create-session claims.

## Remaining boundary

Explicit desktop finalization, pending-cancellation, stream-identity, and usage-probe hosts still bind
SessionManager directly. The next slice should consolidate the smallest cohesive stream lifecycle
cluster behind the injected port without changing stream teardown ordering.
