---
changelog_id: 498
changed_at: 2026-08-05
---

# CHANGELOG_498_claude-user-message-stream-core-boundary: Port queued user input

## Summary

Claude queued-user-message materialization and dequeue sequencing now run in a host-neutral Core.
Desktop attachment reads, provider message IDs, and wall clock are injected through one host while
the existing StreamProcessor API remains unchanged.

## Host-neutral user message stream Core

- Added `user-message-stream-core.ts` with lazy plain/attachment message construction, immutable
  handoff metadata, FIFO dequeue, retirement and source-identity fences, deferred user-event
  correlation, submitting state, turn-in-flight ownership, and wait/notify sequencing.
- Preserved lazy base64 materialization so queued images remain path-only until dequeue, including
  the deletable failed-attachment state and its bounded user-visible error event.
- Made attachment reads, fallback provider IDs, and event time explicit host ports without moving
  queue authority or provider-facing message construction into the desktop layer.

## Thin desktop host and stable facade

- Added `user-message-stream-host.ts` as the sole owner of filesystem reads, `randomUUID`, and the
  wall clock.
- Reduced `user-message-stream.ts` to stable Core/Host wrappers; StreamProcessor and all bridge
  callers keep their existing imports and method signatures.
- Added direct Core tests for attachment materialization, dequeue identity/state, and retained
  attachment failures, plus a direct host test for file reads, UUIDs, and time.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, repositories, diagnostics,
  Node built-ins, Electron, and electron-log from user message stream Core.
- Added Claude user message stream Core as the sixty-third executable Node 22 boundary candidate.

## Validation

- Focused Core/host, StreamProcessor, retirement, and message-controller coverage: passed, 5 files /
  20 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 692 files / 4,915 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep user-message stream Core, desktop host, stable facade, InternalSession queue contracts,
direct-import rule, and FIFO/retirement/attachment tests together. Attachment bytes must stay lazy,
failed deferred turns must remain deletable, and retirement/source replacement must stop dequeue.

## Remaining boundary

Claude queued user input is now host neutral. The wider provider output stream plus concrete
provider composition/repository ownership remain, alongside real Linux/SSH/Feishu/provider
acceptance.
