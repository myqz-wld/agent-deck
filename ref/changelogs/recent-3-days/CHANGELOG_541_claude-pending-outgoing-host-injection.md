---
changelog_id: 541
changed_at: 2026-08-05
---

# CHANGELOG_541_claude-pending-outgoing-host-injection: Inject Claude pending-outgoing ownership

## Summary

The Claude bridge no longer imports the desktop pending-outgoing facade. Queue projection, handoff
snapshotting, and provider cancellation now call the existing Core directly, while ignored-message
tombstones arrive through one required host composed at the desktop boundary.

## Single pending-outgoing composition

- Added `ClaudePendingOutgoingHost` to required bridge options and adapter-init composition.
- Added one desktop host that delegates ignored provider-message IDs to the bounded acceptance Core.
- Routed pending-list projection, successful cancellation removal, and handoff queue snapshots
  directly through their Core functions.
- Expanded the bridge architecture rule to reject both the pending-outgoing facade and desktop host.

## Preserved queue behavior

- Deferred user messages retain their FIFO order and stable public projection.
- Provider cancellation still removes a pending message only after the provider accepts cancellation.
- Failed provider cancellation leaves the pending message available for retry.
- Successful cancellation still records an ignored-message tombstone before queue removal, fencing a
  late provider echo without growing the tombstone set beyond its existing bound.
- Handoff snapshots remain provider-neutral and do not consume queued messages.

## Direct evidence

- A host-level regression proves provider-echo tombstones remain bounded to 32 entries.
- A bridge-level regression injects an observable host and proves successful provider cancellation
  uses that exact host.
- Existing queue, cancellation, echo-acceptance, handoff, and adapter-init suites retain ordering,
  rollback, and late-echo coverage.

## Validation

- Focused Core/host/cancellation/bridge/init coverage: passed, 6 files / 17 tests.
- Complete Claude adapter coverage: passed, 124 files / 495 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 736 files / 5,027 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, direct Core calls, desktop tombstone adapter, cancellation regression, and
architecture prohibitions together. Reintroducing the facade would restore a hidden desktop
acceptance dependency inside the provider bridge.

## Remaining boundary

The bridge still constructs the desktop `StreamProcessor` facade, although the stream Core already
accepts one aggregate host. The next bounded slice can inject that host through adapter
initialization without changing stream identity, timeout, translation, finalization, or queue
semantics.
