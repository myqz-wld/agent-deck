---
changelog_id: 524
changed_at: 2026-08-05
---

# CHANGELOG_524_claude-session-manager-port-boundary: Inject Claude session ownership

## Summary

Claude adapter construction now supplies one narrow SessionManager port to native-fork rollback and
the SDK create-session pipeline. The adapter facade, create orchestrator, and SDK query no longer
import the desktop SessionManager singleton; the desktop adapter host owns the concrete binding.

## Session ownership port

- Added `ClaudeSessionManagerPort` for SDK claim/release, pending-cwd ownership, and session deletion.
- Added a host-neutral binder that preserves exact arguments, release-callback identity, deletion
  promise identity, and the injected manager instance.
- Bound that port once in `desktopClaudeAdapterInitHost` and passed it through bridge options.

## Adapter and create-session injection

- Made `ClaudeCodeAdapter` consume its injected adapter host for bridge construction and native-fork
  rollback deletion instead of importing the singleton.
- Added the port to the bridge's create-session dependency bundle.
- Replaced direct singleton access in create preparation, resume claiming, early visible startup,
  real-id claiming, SDK-query rollback, and outer preparation rollback.
- Preserved pending-cwd release, resume claim release, orphan-row cleanup, and original failure
  authority unchanged.

## Direct evidence and architecture gate

- Added direct port tests covering claim/release, TTL forwarding, release identity, delete routing,
  and promise identity.
- Updated adapter-host, native-fork, create-failure, timeout, permission-mode, and pending-action
  fixtures to provide the same injected manager used by their assertions.
- Added static rules rejecting direct SessionManager imports from the adapter facade, bridge facade,
  create orchestrator, and SDK query.
- Added the port binder as the eighty-eighth independently bundled Node 22 candidate.

## Validation

- Focused injection and create lifecycle coverage: passed, 10 files / 46 tests.
- Complete Claude adapter coverage: passed, 113 files / 483 tests.
- `mise exec -- pnpm typecheck`: passed.
- Architecture and Node bundle gates passed with 88 candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 725 files / 5,015 tests plus 1 skipped.
- The changed Claude bridge facade is 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the port, desktop binding, adapter and bridge plumbing, create-session consumers, tests, and
architecture gates together. Partial application would let claims and rollback deletion use
different manager instances or restore a hidden desktop singleton dependency.

## Remaining boundary

Claude recovery and several explicit desktop bridge hosts still bind SessionManager directly. The
next extraction should inject the smallest cohesive recovery or finalization cluster through this
same port without changing provider process or persistence ordering.
