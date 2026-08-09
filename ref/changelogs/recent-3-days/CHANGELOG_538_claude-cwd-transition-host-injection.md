---
changelog_id: 538
changed_at: 2026-08-05
---

# CHANGELOG_538_claude-cwd-transition-host-injection: Inject Claude transition reads

## Summary

The Claude bridge no longer constructs the desktop cwd-transition controller facade. Transition
state and rollback remain owned by the existing Core while persisted session reads now arrive
through one required host supplied by adapter initialization.

## Single transition composition

- Added `ClaudeCwdTransitionHost` to required bridge options and adapter-init composition.
- Constructed `ClaudeCwdTransitionControllerCore` directly in the bridge with the injected host.
- Kept the transition context bound to the bridge's existing close, create, continuation capture,
  preparation, cleanup, and live-session state seams.
- Expanded the bridge architecture rule to reject both the controller facade and its desktop host.

## Preserved transition behavior

- Generation arming, active-turn rejection, same-cwd no-op, and live cwd reporting are unchanged.
- Target creation still restores queued messages and accepted idempotency fingerprints.
- Failed target creation still rebuilds the original cwd and reports both errors if rollback fails.
- Both continuation captures remain cleaned in the existing finally barrier.

## Direct evidence

- A bridge-level regression injects an observable transition host and proves the bridge reads the
  persisted transition record through that host before any continuation capture.
- Adapter-init tests prove the exact transition host reaches bridge construction.
- Existing Core and facade suites retain generation, target replacement, queue migration, rollback,
  and cleanup coverage.

## Validation

- Focused transition Core/host/facade/bridge/init coverage: passed, 6 files / 10 tests.
- Complete Claude adapter coverage: passed, 120 files / 491 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 732 files / 5,023 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, direct Core construction, bridge-owned lifecycle context, observable-host
regression, and architecture prohibitions together. Reintroducing the facade would rediscover the
desktop session repository inside the provider bridge.

## Remaining boundary

The ordinary Claude message path still imports its desktop facade even though a Core/host split
already exists. The next bounded slice can inject that host without changing queue, handoff,
idempotency, or recovery behavior.
