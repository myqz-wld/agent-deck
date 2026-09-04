---
changelog_id: 480
changed_at: 2026-08-05
---

# CHANGELOG_480_browser-ownership-registry-core-boundary: Port browser ownership state

## Summary

Browser owner identity, leases, generation fencing, disposal, and tab capacity limits no longer
depend on Electron windows. A generic Node Core now owns that state machine while the existing
registry facade retains window/tab construction.

## Host-neutral ownership Core

- Added `registry-core.ts` with deterministic owner cache keys and isolated storage partitions.
- Moved owner reuse, lease reference counting, stale-lease fencing, per-owner disposal, global
  disposal, and total/per-owner tab caps into a generic owner-resource registry.
- Preserved force-dispose behavior: releasing a stale lease cannot dispose a replacement owner
  generation.

## Stable Electron facade

- Kept `BrowserOwnerHandle`, `EngineTab`, BrowserWindow construction, window visibility/title, and
  the shared production singleton in `registry.ts`.
- Delegated the public `BrowserEngine` ownership methods to Core without changing their signatures.
- Preserved the existing non-generic public `BrowserOwnerLease` type while keeping the reusable Core
  lease generic internally.

## Executable boundary gate

- Added a direct-import rule rejecting the Electron registry/tab implementations, browser fronts,
  MCP handlers, session/store/runtime hosts, utilities, Electron, and electron-log from Core.
- Added browser ownership registry Core as the forty-fifth executable Node 22 boundary candidate.
- Added direct Core generation/capacity regressions alongside the existing BrowserEngine, Codex pipe,
  MCP browser tool, action, and shutdown suites.

## Validation

- Focused Core/registry/actions/Codex-pipe/MCP/shutdown coverage: passed, 6 files / 73 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-five Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 658 files / 4,862 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the ownership Core, Electron delegation, public lease compatibility alias, generation/capacity
tests, direct-import rule, and bundle candidate together. Ownership records must not return to
BrowserWindow or transport connection state.

## Remaining boundary

Browser owner registry and lease/capacity lifecycle are host neutral. Per-owner tab collection and
Electron window creation remain coupled in `BrowserOwnerHandle`; broader live provider/repository
paths and real Linux/SSH/Feishu/provider acceptance also remain.
