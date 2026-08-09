---
changelog_id: 531
changed_at: 2026-08-05
---

# CHANGELOG_531_claude-restart-session-host-injection: Inject Claude restart ownership

## Summary

Claude permission-mode and sandbox cold restarts no longer import the desktop session repository or
event bus. One required adapter-owned host now supplies persisted reads, paired write/publication
operations, and the rename subscription used by the shared restart single-flight state machine.

## One symmetric restart host

- Added a Node-safe restart-host contract for full persisted-session reads, permission and sandbox
  updates, renderer publication, and session-rename subscription.
- Bound the concrete repository and typed event bus only in the desktop restart host.
- Kept each persisted mutation and its `session-upserted` publication in one host operation so the
  success and rollback paths cannot drift apart.
- Made the host a required bridge option and threaded it through the unique adapter initialization
  composition alongside the existing create host and SessionManager port.

## Preserved cold-restart state machine

- Permission and sandbox restarts still share the same `recovering` map with disconnect recovery.
- Rename events still transfer the exact in-flight promise from the old application id to the new
  id, and the returned unsubscriber is always called in the outer `finally` block.
- Continuation capture still precedes the placeholder and close side effects.
- Persisted values still change before native resume and roll back before the user-visible failure
  message when create/resume fails.
- Native-jsonl reuse, missing-jsonl fallback, Gateway/Agent/Plugin identity, permission, sandbox,
  extra-write roots, and application/native session-id separation are unchanged.

## Direct evidence and architecture gate

- Desktop-host tests prove read delegation, paired write/publication, and exact rename unsubscribe.
- Existing restart race tests cover old-to-new map transfer, unrelated renames, multi-waiter single
  flight, rollback, and listener cleanup through the injected host.
- Existing jsonl-precheck tests cover both restart methods across native resume, fallback, capture
  failure, and rollback.
- Added a static rule rejecting store, event-bus, SessionManager singleton, or desktop restart-host
  imports from the restart controller.
- A direct import scan finds no desktop repository or event-bus dependency in the controller.

## Validation

- Focused restart/init/host coverage: passed, 6 files / 30 tests.
- Complete Claude adapter coverage: passed, 115 files / 486 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 727 files / 5,018 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains at 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the restart-host contract, desktop binding, required bridge option, controller consumer, tests,
and architecture rule together. A partial change could publish a value from a different repository
snapshot, lose rename cleanup, or make the success and rollback paths observe different owners.

## Remaining boundary

The Claude bridge facade still directly reads the desktop event repository for the latest
conversation timestamp used by recovery continuation fencing. That read-only seam is the next
small deterministic repository extraction before broad provider-runtime composition work.
