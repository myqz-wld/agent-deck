---
changelog_id: 540
changed_at: 2026-08-05
---

# CHANGELOG_540_claude-session-lifecycle-host-injection: Inject Claude lifecycle ownership

## Summary

The Claude bridge no longer imports the desktop session-lifecycle facade. Persisted-session reads,
pending cleanup, claim release, and lifecycle diagnostics now arrive through one required host
while the existing lifecycle Core keeps interrupt, close, drain, retirement, and mode authority.

## Single lifecycle composition

- Added the typed `ClaudeSessionLifecycleHost` to required bridge options and adapter-init
  composition.
- Built the desktop host once from the injected Claude SessionManager port.
- Routed interrupt, ordinary close, strict rollback close, retirement, and live permission-mode
  changes directly through their Core functions.
- Expanded the bridge architecture rule to reject both the lifecycle facade and its desktop host.

## Preserved lifecycle behavior

- Interrupt errors remain visible to callers while diagnostic failures remain observational.
- Ordinary close remains best-effort; strict rollback close still requires provider-stream proof.
- The one-second stream-drain bound, pending cancellation, accepted-enqueue cleanup, and exact claim
  release are unchanged.
- Permission-mode mutations remain serialized per session and roll back the in-memory mode when the
  SDK rejects a change.

## Direct evidence

- A bridge-level regression injects an observable lifecycle host and proves close cleanup uses that
  host with the exact session, key, and deletion intent.
- Adapter-init tests prove the exact lifecycle host reaches bridge construction and retains
  persisted-session visibility.
- Existing strict-close, Core, host, and rollback suites retain drain, failure, cleanup, and
  serialization coverage.

## Validation

- Focused lifecycle Core/host/strict-close/rollback/bridge/init coverage: passed, 7 files / 19 tests.
- Complete Claude adapter coverage: passed, 122 files / 493 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 734 files / 5,025 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, direct Core calls, one desktop host instance, bridge-owned session map,
observable cleanup regression, and architecture prohibitions together. Reintroducing the facade
would rediscover repositories, the SessionManager, and diagnostics inside the provider bridge.

## Remaining boundary

The bridge still imports the pending-outgoing facade, whose Core already accepts an explicit host
for provider-message cancellation tombstones. The next bounded slice can inject that host without
changing queue snapshots, provider cancellation, or late-echo fencing.
