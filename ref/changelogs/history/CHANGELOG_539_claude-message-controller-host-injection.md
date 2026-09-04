---
changelog_id: 539
changed_at: 2026-08-05
---

# CHANGELOG_539_claude-message-controller-host-injection: Inject Claude message ingress

## Summary

The Claude bridge no longer imports the desktop ordinary-message facade. Handoff/worktree ingress
guarding, accepted-enqueue diagnostics, and timestamps now arrive through one required host while
the existing Core keeps recovery, queue, validation, and idempotency authority.

## Single message composition

- Added `ClaudeMessageControllerHost` to required bridge options and adapter-init composition.
- Routed both `sendMessage` and `enqueueMessage` directly through `sendClaudeMessageCore` with the
  injected host.
- Kept recovery recursion, lazy provider message construction, live-session lookup, and event
  publication bound to the bridge's existing state seams.
- Expanded the bridge architecture rule to reject both the message facade and its desktop host.

## Preserved message behavior

- Active handoff/worktree transitions still divert ingress before live-session lookup.
- Missing live sessions still enter the existing single-flight recovery path.
- Queue bounds, deferred user events, provider cancellation, and accepted idempotency fingerprints
  are unchanged.
- A failed event projection still cannot revoke an already accepted keyed enqueue.

## Direct evidence

- A bridge-level regression injects an observable ingress guard and proves both ordinary and queued
  entry points use it, including the worktree-transition bypass flag.
- Adapter-init tests prove the exact message host reaches bridge construction.
- Existing Core and facade suites retain recovery, queueing, idempotency, handoff, and diagnostic
  coverage.

## Validation

- Focused message Core/host/facade/bridge/init coverage: passed, 6 files / 13 tests.
- Complete Claude adapter coverage: passed, 121 files / 492 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 733 files / 5,024 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, direct Core calls, bridge-owned recovery/queue context, observable-host
regression, and architecture prohibitions together. Reintroducing the facade would rediscover
handoff state, logging, and the wall clock inside the provider bridge.

## Remaining boundary

The Claude bridge still imports the desktop session-lifecycle facade even though lifecycle Core and
host seams already exist. The next bounded slice can inject one lifecycle host without changing
interrupt, close, drain, cleanup, retirement, or permission-mode behavior.
