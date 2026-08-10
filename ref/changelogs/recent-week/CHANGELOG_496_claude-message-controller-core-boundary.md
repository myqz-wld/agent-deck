---
changelog_id: 496
changed_at: 2026-08-05
---

# CHANGELOG_496_claude-message-controller-core-boundary: Port message ingress policy

## Summary

Claude ordinary message ingress, queueing, recovery, idempotency, and user-event emission now run
in a host-neutral Core. Desktop handoff/worktree diversion, wall clock, and accepted-enqueue
diagnostics are injected through one host.

## Host-neutral message controller Core

- Added `message-controller-core.ts` with message/session validation, missing-session recovery,
  queue overflow policy, deferred user-event metadata, attachment copying, accepted-key payload
  fingerprints, bounded retry deduplication, notification, and immediate user-event emission.
- Preserved source-handoff rollback replay, persisted-event exactly-once flags, recovery enqueue
  options, successor ownership, and identical-payload retry behavior.
- Made accepted keyed enqueue authority survive both event-sink and observer failures while keeping
  unkeyed event failures authoritative.

## Thin desktop host and stable facade

- Added `message-controller-host.ts` as the sole owner of handoff/worktree ingress diversion,
  desktop logging, and the wall clock.
- Reduced `message-controller.ts` to a stable Core/Host wrapper, preserving the bridge call shape and
  exported context contract.
- Added direct Core and host tests alongside the existing handoff, queue, recovery, correlation,
  pending-outgoing, accepted-key, and retry-conflict suite.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, handoff runtime, repositories,
  diagnostics, Node built-ins, Electron, and electron-log from message controller Core.
- Added Claude message controller Core as the sixty-first executable Node 22 boundary candidate.

## Validation

- Focused Core/host and message-controller coverage: passed, 3 files / 10 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 688 files / 4,908 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep message Core, desktop host, stable facade, enqueue-idempotency and validation helpers,
direct-import rule, and handoff/recovery/idempotency tests together. Handoff-owned input must never
reach the old provider queue, keyed retries must not duplicate turns, and payload conflicts must
remain rejected.

## Remaining boundary

Claude ordinary message ingress is now host neutral. Tool-permission and stream processing plus
concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
