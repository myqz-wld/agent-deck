---
changelog_id: 461
changed_at: 2026-08-05
---

# CHANGELOG_461_codex-client-lifecycle-host-boundary: Inject Codex lifecycle observers

## Summary

The Codex app-server client no longer selects desktop generation diagnostics or constructs the
Agent Deck MCP startup observer directly. Both dependencies now come from the same explicit client
host that already owns process startup and process-level diagnostics.

## Lifecycle host boundary

- Extended the client host with a generation-diagnostics contract and MCP-observer factory.
- Exported the generation controller's inert diagnostics implementation for non-desktop hosts.
- Added a structural MCP startup observer contract and kept the bounded observer implementation
  independent of the client.
- Moved desktop generation logging and process-run identity selection into the desktop host
  composition while preserving the exact existing observer and logging implementations.
- Constructed the injected observer once per client and reset it on child detach exactly as before.
- Preserved generation readiness, failure logging, control-plane retirement, observer LRU bounds,
  fixed diagnostic fields, clock rollback handling, and sibling-client host identity.

## Boundary gates and regressions

- Strengthened the client import rule to reject both desktop lifecycle adapters.
- Kept the client-host port inside the existing twenty-six executable Node 22 bundle candidates.
- Added direct checks that the injected observer is created once, observes notifications, publishes
  through the diagnostics port, resets on detach, and that the generation controller receives the
  exact host-supplied diagnostics object.

## Validation

- Focused client-host, MCP observer, generation controller, process, and recycle coverage: passed,
  5 files / 34 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 627 files / 4,813 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; the app-server client is 490 lines, 113 structured changelogs, maximum id 461.

## Do Not Split Protection

Keep the client-host lifecycle fields, desktop composition, controller/observer call sites, direct
regressions, and import gates together. Host observations may report lifecycle state but cannot
change generation authority, request delivery, notification order, or retirement decisions.

## Remaining boundary

The client still selects the desktop Browser-bootstrap adapter and desktop thread factory directly.
Move those construction policies into the client host before publishing the complete app-server
client as an Electron-free Core candidate. No shared development or Electron process was started,
restarted, stopped, or killed.
