---
changelog_id: 508
changed_at: 2026-08-05
---

# CHANGELOG_508_claude-user-message-acceptance-core-boundary: Port provider echo acceptance

## Summary

Claude provider user-message echo acceptance and late-echo fencing now run in a host-neutral Core.
The stable facade supplies only adapter identity and time, while pending cancellation continues to
reuse the same bounded ignored-message policy.

## Host-neutral acceptance Core

- Added `user-message-acceptance-core.ts` with exact user/UUID matching, ignored-echo consumption,
  authoritative submitted-message matching, and deferred user-event emission.
- Preserved payload projection for text, attachments, and turn correlation while moving adapter id
  and timestamp behind an explicit host port.
- Preserved discard behavior and the insertion-ordered 32-message ignored-ID ceiling so successful
  cancellation cannot later persist a delayed provider echo.

## Thin desktop facade

- Reduced `user-message-acceptance.ts` to a compatibility facade that injects the Claude adapter id
  and `Date.now`; discard and ignored-ID functions remain stable aliases.
- Kept pending-outgoing's ignored-message host port wired to the same facade, avoiding a second
  late-echo ledger or divergent capacity policy.
- Added direct Core tests for matching acceptance, malformed/mismatched input, one-shot ignored
  echoes, deferred attachment/correlation projection, discard, and bounded FIFO eviction.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, adapter constants, concrete stores/runtime
  utilities, Node built-ins, Electron, and electron-log from user-message acceptance Core.
- Added Claude user-message acceptance Core as the seventy-third executable Node 22 boundary
  candidate.

## Validation

- Focused Core/pending/message-controller/stream-processor coverage: passed, 5 files / 24 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 708 files / 4,963 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep acceptance Core, stable facade, bounded ignored-ID policy, pending-outgoing wiring, direct-
import rule, and echo-race tests together. Only the exact provider echo may persist the deferred
user event, an ignored echo must be consumed once, and the fence must stay bounded.

## Remaining boundary

Claude user-message echo acceptance is now host neutral. Provider output streaming plus concrete
create/recovery composition and repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
