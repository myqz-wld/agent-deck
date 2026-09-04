---
changelog_id: 489
changed_at: 2026-08-05
---

# CHANGELOG_489_claude-session-finalize-core-boundary: Port registration sequencing

## Summary

Claude session-start finalization no longer owns the desktop session repository, session manager,
event bus, logger, or wall clock. A host-neutral Core owns registration and presentation ordering
while a desktop host performs persistence and publication.

## Host-neutral finalize Core

- Added `session-finalize-core.ts` with the authoritative sequence: emit session-start, settle the
  spawn registration, persist native/runtime metadata, publish the persisted row, then emit the
  optional first user message.
- Preserved application/native identity, linked-spawn and hidden-history metadata, continuation
  lineage, handoff and attachment projection, plus independent start/message suppression flags.
- Kept every persistence step failure-isolated so one unavailable metadata field cannot suppress
  later persistence or the first visible message; diagnostics are also non-authoritative.

## Thin desktop host and facade

- Added `session-finalize-host.ts` as the sole owner of session-manager native-id updates, repository
  setters/reads, event-bus publication, wall-clock reads, and diagnostics.
- Reduced the stable finalize module to a typed compatibility wrapper over Core and Host, with no
  call-site or input-contract change.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, bridge session types,
  runtime/session/store/event/diagnostic utilities, Node built-ins, Electron, and electron-log from
  Core.
- Added Claude session finalize Core as the fifty-fourth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, stable facade, and real create-session fail-fast coverage: passed,
  4 files / 20 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-four Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 674 files / 4,890 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep finalize Core, desktop host, stable facade, create-session callers, direct-import rule, and
ordering/failure-isolation tests together. The spawn reservation must settle only after the linked
session-start event, and metadata failures must never hide an accepted first user message.

## Remaining boundary

Claude final session registration and initial presentation policy are now host neutral. Stream
processing, permission responses, recovery orchestration, and real Linux/SSH/Feishu/provider
acceptance remain.
