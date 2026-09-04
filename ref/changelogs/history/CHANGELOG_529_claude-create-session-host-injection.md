---
changelog_id: 529
changed_at: 2026-08-05
---

# CHANGELOG_529_claude-create-session-host-injection: Inject Claude create ownership

## Summary

The live Claude create/resume path now receives its persisted-session, Gateway/default-setting, and
transient-record cleanup owner from adapter initialization. The orchestrator and SDK query no longer
import the desktop session repository or select desktop defaults through hidden singleton wrappers.

## Complete create host

- Expanded the existing Claude session-defaults contract with the exact persisted profile,
  lifecycle, native-session identity, and Agent/Plugin fields consumed during create and resume.
- Added one narrow transient-session deletion operation for failure cleanup; it deliberately cannot
  delete the stable application session used by a native resume.
- Kept model, effort, sandbox, Gateway, and profile precedence in the existing pure Core resolvers.
- Bound the concrete repository, settings store, and Gateway profile resolver only in the desktop
  session-defaults host.

## Production injection

- Made the create host a required `SdkBridgeOptions` dependency and threaded it through the adapter
  initialization Core into the bridge.
- Resolved the selected or persisted Gateway through the injected host before dispatching the
  create orchestrator.
- Read persisted Agent/Plugin defaults and visible-failure lifecycle state from that same host.
- Resolved the native resume id through the injected persisted record and routed both failure
  cleanup sites through the injected transient-record operation.
- Preserved the adapter initialization module as the unique production composition point; tests
  can now supply an alternative host without replacing desktop modules globally.

## Failure and resume invariants

- Empty-prompt fail-fast, trusted-continuation restrictions, SDK ownership claims, and first-id
  fencing are unchanged.
- Spawn failure still removes only its random temporary row; normal resume never deletes the stable
  application row.
- The effective native resume id retains the exact explicit, persisted, application-id fallback
  order.
- Visible startup errors remain suppressed for missing or already-closed persisted sessions.

## Direct evidence and architecture gate

- Adapter-init coverage proves the exact create host object reaches bridge construction.
- Desktop-host coverage proves persisted reads and transient deletion delegate to the intended
  repository while settings and Gateway resolution stay unchanged.
- Added static rules rejecting future session-store or desktop-default imports from the create
  orchestrator and SDK query, and rejecting the old hidden Gateway wrapper from the bridge facade.
- Direct import scans find no session repository dependency in either live create module.

## Validation

- Focused create/default/init coverage: passed, 7 files / 26 tests.
- Complete Claude adapter coverage: passed, 114 files / 484 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 726 files / 5,016 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains at 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the create-host contract, desktop binding, required bridge option, orchestrator/query consumers,
tests, and architecture rules together. A partial change could resolve a Gateway or resume identity
from a different repository snapshot than the one used for cleanup and visible failure fencing.

## Remaining boundary

Concrete Server Core and Local Worker runtime factories are still injected external modules, and
other provider restart/recovery controllers retain desktop repository hosts. The next deterministic
slice should select the smallest remaining production repository owner without broadening the Linux
runtime-module contract or claiming real-platform acceptance.
