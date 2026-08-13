---
changelog_id: 521
changed_at: 2026-08-05
---

# CHANGELOG_521_session-lifecycle-core-boundary: Isolate session lifecycle orchestration

## Summary

Session close, archive, reactivation, pin, permission, and deletion ordering now lives in one
host-neutral state machine. Electron Browser disposal, desktop diagnostics, repository access,
team coordination, event publication, MCP tokens, handoff fencing, and worktree policy remain
explicit host ports.

## Lifecycle Core

- Added `SessionLifecycleCore` with the existing close-epoch and dual application/native identity
  deletion fences.
- Preserved explicit close ordering: revoke handoff authority, await adapter retirement, persist
  closed state, dispose session Browser ownership, publish, release the MCP token, then settle team
  side effects.
- Preserved synchronous natural-close behavior while keeping its structured side-effect barrier
  observable and bounded.
- Preserved archive/unarchive, reactivation, pin, creation-time permission, team refresh, and exact
  delete ordering without importing a desktop singleton.
- Kept adapter-close failures non-authoritative on explicit close/delete and routed diagnostics
  through the owning host.

## Desktop binding

- Reduced `manager/lifecycle.ts` to the desktop host binding and compatibility facade.
- Kept the existing session repository, Browser engine, event bus, team coordinator, MCP token map,
  handoff coordinator, and worktree deletion gate on the desktop side.
- Existing `SessionManager` callers retain the same public methods and sequencing.

## Direct evidence and architecture gate

- Added direct tests for natural close, explicit-close degradation/order, archive/reactivate/pin/
  permission projection, deletion order, close-epoch cleanup, and dual-identity fencing.
- Added an architecture rule rejecting desktop lifecycle, Browser, event bus, repositories, MCP,
  team, handoff, worktree, logger, Electron, and Electron-log imports from the Core.
- Added the lifecycle Core as the eighty-fifth independently bundled Node 22 candidate.

## Validation

- Focused lifecycle/manager coverage: passed, 4 files / 30 tests.
- `mise exec -- pnpm typecheck`: passed.
- Architecture and Node bundle gates passed with 85 candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 722 files / 5,009 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, and changed-file line checks passed; the largest
  new file is 214 lines and the desktop binding is 125 lines.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core state machine, desktop binding, direct tests, and both architecture gates together.
Close intent, adapter retirement, Browser/token/team cleanup, deletion fencing, and publication are
one ordered lifecycle contract.

## Remaining boundary

The lifecycle state machine is reusable outside Electron, but the concrete provider adapters still
enter through a desktop-owned `SessionManager` singleton. The next extraction must make that facade
accept an explicit lifecycle/repository host before the packaged Server Core factory can own it.
