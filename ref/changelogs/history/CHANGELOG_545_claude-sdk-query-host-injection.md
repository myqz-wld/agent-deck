---
changelog_id: 545
changed_at: 2026-08-05
---

# CHANGELOG_545_claude-sdk-query-host-injection: Inject Claude SDK query composition

## Summary

The Claude create-session SDK-query orchestrator no longer imports desktop SDK loading, runtime,
binary, injection, sandbox, MCP, query-option, metadata, Gateway-settings, or logging facades.
Adapter initialization now supplies one required aggregate host for that composition.

## Aggregate query host

- Added the host-neutral `ClaudeCreateSessionSdkQueryHost` contract for SDK query construction and
  cleanup.
- Added one desktop host that composes the existing SDK loader, runtime and binary resolution,
  prompt/plugin injection, sandbox, MCP, query-option, metadata-hook, Gateway-settings, and logger
  owners.
- Threaded the required host through adapter initialization, bridge options, and create-session
  dependencies.
- Kept the query orchestrator responsible only for sequencing, cancellation fences, session-map
  registration, first-provider-id adoption, claim ownership, and rollback authority.
- Expanded architecture rules so the bridge and create-session modules cannot rediscover the
  aggregate desktop host or its constituent facades.

## Preserved lifecycle behavior

- SDK loading, MCP preparation, and Gateway settings still finish before the final cancellation
  fence and synchronous query registration.
- Resume identity retains the exact application-id versus CLI-id separation and persisted fallback.
- Failed startup still interrupts once, deletes both possible session-map keys, releases pending
  cwd and SDK claims, cleans Gateway settings, and removes only safe transient rows.
- Injected sandbox and warning diagnostics are observed best-effort and cannot alter startup or
  cleanup control flow.

## Direct evidence

- A bridge-level regression injects the aggregate host and proves its loader, runtime, binary,
  sandbox observer, system-prompt, plugin, metadata, MCP, and query-option inputs reach the live SDK
  query boundary.
- Adapter-init coverage proves the exact desktop aggregate reaches bridge construction.
- Recovery and consume-fork mocks now expose the complete SDK-injection facade used by the desktop
  host, preventing partial module mocks from hiding composition drift.

## Validation

- Focused create/init/query coverage: passed, 8 files / 42 tests.
- Complete Claude adapter coverage: passed, 125 files / 499 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 737 files / 5,031 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required aggregate host, desktop composition, bridge/init threading, direct query-boundary
regression, and architecture prohibitions together. Partial injection would let the orchestrator
rediscover desktop settings, paths, diagnostics, or cleanup ownership.

## Remaining boundary

Residual Claude orchestration still includes direct desktop diagnostics in restart and recovery,
plus the stream host's dependency on the desktop message-translation facade. The next bounded slice
should remove one such dependency without changing retry, recovery, or stream terminal semantics.
