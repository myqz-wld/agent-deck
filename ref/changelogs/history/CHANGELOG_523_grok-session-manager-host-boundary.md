---
changelog_id: 523
changed_at: 2026-08-05
---

# CHANGELOG_523_grok-session-manager-host-boundary: Inject Grok session ownership

## Summary

The Grok adapter now receives its SessionManager capabilities through adapter composition instead
of importing the desktop singleton throughout bridge and runtime lifecycle code. The desktop adapter
host remains the only production Grok binding for the concrete singleton and cleanup diagnostics.

## Host injection

- Added a narrow `GrokSessionManagerPort` for claim, release, native-id update, delete, and close
  operations used by the Grok bridge.
- Passed that port and the startup-cleanup diagnostic callback through `GrokAdapterHost` and
  `createGrokAdapterBridgeWithHost`.
- Kept the public desktop adapter factory compatible while making `adapter-host.ts` the single
  production Grok file that imports the desktop `sessionManager` singleton.

## Lifecycle preservation

- Injected the manager into bridge claim ownership, runtime disposal, missing-runtime recovery,
  native-session-id binding, and failed-startup registration cleanup.
- Preserved claim/release identity, cleanup ordering, original error authority, and the existing
  delete-then-mark-closed fallback.
- Kept warning emission in the desktop host; the host-neutral cleanup helper now reports failures
  only through its injected callback.

## Direct evidence and architecture gate

- Added direct cleanup tests for successful deletion and the reporting plus `markClosed` fallback.
- Updated adapter-host, strict-cleanup, runtime lifecycle, and recovery tests to use explicit manager
  ports and prove the same production sequences.
- Added architecture rules that reject direct SessionManager singleton imports from the bridge,
  runtime start, runtime lifecycle coordinator, and cleanup Core.
- Added startup cleanup as the eighty-seventh independently bundled Node 22 candidate.

## Validation

- Full Grok adapter coverage: passed, 39 files / 218 tests.
- `mise exec -- pnpm typecheck`: passed.
- Architecture and Node bundle gates passed with 87 candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 724 files / 5,014 tests plus 1 skipped.
- The production singleton-import scan reports only `adapter-host.ts`; the cached Git index remains
  empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the manager port, adapter-host injection, lifecycle consumers, direct tests, and architecture
rules together. A partial change would either restore hidden desktop ownership or leave cleanup and
claim sequencing on different manager instances.

## Remaining boundary

Other provider bridge clusters still bind the desktop SessionManager directly. The next extraction
should inject the same facade contract through one smallest cohesive Claude or Codex lifecycle
cluster, without expanding the trusted runtime-module or Linux packaging contract.
