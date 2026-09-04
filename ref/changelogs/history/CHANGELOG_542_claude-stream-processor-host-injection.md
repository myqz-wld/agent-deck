---
changelog_id: 542
changed_at: 2026-08-05
---

# CHANGELOG_542_claude-stream-processor-host-injection: Inject Claude stream ownership

## Summary

The Claude bridge no longer constructs the desktop `StreamProcessor` facade. Adapter
initialization now supplies one aggregate stream host, and the bridge plus create-session contract
use `ClaudeStreamProcessorCore` directly.

## Single stream composition

- Added `ClaudeStreamProcessorHost` to required bridge options and adapter-init composition.
- Built the desktop aggregate host once from the injected Claude SessionManager port.
- Constructed `ClaudeStreamProcessorCore` directly in the bridge and removed the facade type from
  create-session dependencies.
- Expanded the bridge architecture rule to reject both the stream facade and its desktop host.

## Preserved stream behavior

- Lazy attachment materialization and provider-neutral queued-message retention are unchanged.
- First-message timeout, interrupt fallback, first provider-ID adoption, resume/fork identity, and
  late-ID fencing retain their existing Core implementations.
- SDK message translation, runtime metadata, live usage, permission state, and file-change handling
  still use the same aggregate sub-hosts.
- Terminal result handling, deferred retirement, claim release, session-map cleanup, and the final
  stream-drained barrier remain unchanged.

## Direct evidence

- A bridge-level regression injects an aggregate host and proves queued attachment bytes are read
  through that exact host before provider delivery.
- Existing Core, retirement, user-message, first-ID, timeout, translation, and finalization suites
  retain their race and cleanup coverage.
- Adapter-init tests prove the exact aggregate host reaches bridge construction.

## Validation

- Focused stream Core/retirement/user-message/bridge/init coverage: passed, 6 files / 13 tests.
- Complete Claude adapter coverage: passed, 125 files / 496 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 737 files / 5,028 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required aggregate host, direct Core construction, Core create-session type, observable
attachment regression, and architecture prohibitions together. Reintroducing the facade would
rediscover translation, stream lifecycle, and SessionManager ownership inside the provider bridge.

## Remaining boundary

The create-session orchestrator still imports the desktop session-finalize facade. Its Core already
accepts an explicit host, so the next bounded slice can inject that host without changing session
registration, runtime metadata persistence, first-user publication, or failure cleanup.
