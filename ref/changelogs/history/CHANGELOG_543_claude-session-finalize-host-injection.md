---
changelog_id: 543
changed_at: 2026-08-05
---

# CHANGELOG_543_claude-session-finalize-host-injection: Inject Claude creation finalization

## Summary

The Claude create-session orchestrator no longer imports the desktop session-finalize facade.
Adapter initialization now supplies the required finalize host, and all fast/background/canonical
creation paths call `finalizeClaudeSessionStartCore` directly.

## Single finalization composition

- Added `ClaudeSessionFinalizeHost` to required bridge options and adapter-init composition.
- Built the desktop finalize host once from the injected Claude SessionManager port.
- Threaded the host through create-session dependencies and routed all three finalization paths
  directly through the existing Core.
- Expanded bridge and create-session architecture rules to reject the finalize facade and host.

## Preserved creation behavior

- Fast-return creation still publishes one provisional session start and later persists the
  canonical CLI identity without duplicating the first user event.
- Canonical creation still records sandbox, runtime provider, Agent/Plugin identity, model, effort,
  and additional writable roots before publishing the persisted session.
- Initial handoff metadata, attachments, continuation metadata, and hidden/spawn registration
  remain bound to the same session identity.
- Each repository mutation remains best-effort with non-authoritative diagnostics, while provider
  startup and create-session cleanup retain their fail-fast authority.

## Direct evidence

- A canonical bridge regression injects an observable finalize host and proves CLI identity,
  sandbox, publication, and the host clock are used by the create-session path.
- Existing fast-return, canonical-ID, recovery, Stop-hook, metadata, failure-cleanup, Core, and host
  suites retain their ordering and rollback coverage.
- Adapter-init tests prove the exact finalize host reaches bridge construction.

## Validation

- Focused finalize/create/cleanup/init coverage: passed, 7 files / 28 tests.
- Complete Claude adapter coverage: passed, 125 files / 497 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 737 files / 5,029 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 498 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, all three direct Core call sites, injected-clock regression, create-session
dependency, and architecture prohibitions together. Reintroducing the facade would rediscover
repositories, publication, logging, and SessionManager identity ownership inside the orchestrator.

## Remaining boundary

The create-session orchestrator still imports the desktop `makeCanUseTool` facade. Its Core already
accepts an explicit host, so the next bounded slice can inject permission request identity, clock,
and sandbox-intercept observation without changing decision, timeout, or abort semantics.
