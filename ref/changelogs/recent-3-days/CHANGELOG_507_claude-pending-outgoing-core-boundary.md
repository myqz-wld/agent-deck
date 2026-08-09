---
changelog_id: 507
changed_at: 2026-08-05
---

# CHANGELOG_507_claude-pending-outgoing-core-boundary: Port pending queue authority

## Summary

Claude pending-outgoing queue projection and cancellation now run in a host-neutral Core. The stable
facade supplies only ignored-provider-message bookkeeping, preserving the existing bridge API and
all handoff, removal, and submitted-message race behavior.

## Host-neutral pending-outgoing Core

- Added `pending-outgoing-core.ts` with application/CLI session identity lookup, handoff snapshot
  cloning, public pending-message projection, queued-message removal, and stream wakeup ownership.
- Preserved submitted-message cancellation ordering: mark cancelling, invoke the exact provider
  message cancellation method, restore submitting state on false/rejection, and reject stale races.
- Preserved successful cancellation behavior: fence the late provider echo, clear the submitted
  record and turn-in-flight bit, wake the stream, and return only the public correlation identity.

## Thin desktop facade

- Reduced `pending-outgoing.ts` to stable function aliases plus one wrapper that injects
  `rememberIgnoredClaudeUserMessageId`; provider acceptance bookkeeping stays independently owned.
- Added direct Core tests for application/CLI lookup, cloned handoff payloads, submitting-before-
  queued order, atomic queued removal, successful cancellation, late-echo fencing, and cancellation
  false/rejection rollback.
- Retained the existing message-controller integration tests without changing callers or bridge
  method signatures.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, user-message acceptance implementation,
  concrete stores/runtime utilities, Node built-ins, Electron, and electron-log from pending-
  outgoing Core.
- Added Claude pending-outgoing Core as the seventy-second executable Node 22 boundary candidate.

## Validation

- Focused Core/facade/message-stream/processor coverage: passed, 5 files / 27 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 707 files / 4,960 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep pending-outgoing Core, stable facade, ignored-message port, direct-import rule, and cancellation
tests together. Provider cancellation must never remove a message before affirmative acceptance,
late echoes must remain fenced after success, and stale or failed cancellation must restore the
authoritative submitted state.

## Remaining boundary

Claude pending-outgoing queue authority is now host neutral. Provider output streaming plus concrete
create/recovery composition and repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
