---
changelog_id: 530
changed_at: 2026-08-05
---

# CHANGELOG_530_claude-recovery-session-reader-injection: Inject Claude recovery reads

## Summary

Claude disconnect recovery no longer imports the desktop session repository. It receives a narrow
read-only persisted-session view from the same create host that owns native resume selection, so
the recovery state machine can run under an Electron-free composition without changing behavior.

## Narrow recovery ownership

- Strengthened the create-host contract to return a complete persisted `SessionRecord`; the
  defaults-only parent contract remains intentionally partial for pure precedence tests.
- Added only `readPersistedSession` to the recoverer context rather than exposing repository writes
  or the complete create host.
- Passed the adapter-owned create host into `SessionRecoverer` from bridge construction.
- Replaced the initial recovery lookup and the post-await deletion guard with injected reads.

## Preserved recovery state machine

- Missing records still fail before user-message emission and provider startup.
- The close-epoch baseline remains authoritative for cancellation during continuation preparation
  or SDK pre-registration waits.
- Record deletion during an await remains a terminal cancellation signal.
- Archived auto-unarchive, cwd fallback, native-jsonl healing, placeholder deduplication, single
  flight, attachment delivery, and closed-lifecycle rollback are unchanged.
- Recovery continues to pass the exact persisted Gateway, Agent, Plugin, model, permission,
  sandbox, extra-write, native-session, and cwd values to create/resume.

## Direct evidence and architecture gate

- Existing real recovery suites exercise initial lookup, deletion/cancellation, native resume,
  fallback, concurrent waiters, lifecycle rollback, and late close behavior through the injected
  reader.
- Expanded the recovery architecture rule to reject direct desktop defaults, SessionManager
  singleton, or store imports.
- A direct import scan now finds no session repository dependency in the recovery implementation.

## Validation

- Focused recovery/create/default coverage: passed, 5 files / 64 tests.
- Complete Claude adapter coverage: passed, 114 files / 484 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 726 files / 5,016 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains at 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the full-record create-host contract, narrow recoverer reader, bridge binding, tests, and
architecture rule together. A partial change could evaluate close cancellation against a different
repository instance from the one that supplied the recovery runtime profile.

## Remaining boundary

The Claude cold-restart controller still directly owns permission/sandbox repository mutations and
upsert publication. It is the next small production repository seam; the external Server Core and
Local Worker factories and real-platform acceptance remain separate larger boundaries.
