---
changelog_id: 481
changed_at: 2026-08-05
---

# CHANGELOG_481_browser-tab-collection-core-boundary: Port per-owner tab state

## Summary

Per-owner browser tab identity, active selection, close observation, pruning, and disposal no longer
depend on Electron. A generic Core now owns that collection while `BrowserOwnerHandle` retains only
window/tab construction and initialization.

## Host-neutral tab collection

- Added `tab-collection-core.ts` with per-owner tab id allocation, registration, active selection,
  exact lookup, info projection, destroyed-tab pruning, and count state.
- Moved close listeners, keep-only behavior, forced disposal, idempotence, and the closed-owner open
  barrier into Core.
- Preserved listener delivery during disposal and the fallback to the first remaining tab when the
  active tab disappears.

## Thin Electron owner facade

- Replaced `BrowserOwnerHandle`'s direct Map/counter/listener state with one
  `BrowserTabCollectionCore<EngineTab>`.
- Kept BrowserWindow options, `EngineTab` construction, initial navigation, visibility/focus, and
  engine capacity admission in the Electron facade.
- Preserved every public owner method and its return type for MCP tools and Codex pipe callers.

## Executable boundary gate

- Added a direct-import rule rejecting the Electron registry/tab implementations, browser fronts,
  MCP handlers, session/store/runtime hosts, utilities, Node built-ins, Electron, and electron-log
  from Core.
- Added browser tab collection Core as the forty-sixth executable Node 22 boundary candidate.
- Added direct allocation/activation/prune/listener/disposal regressions alongside the complete
  BrowserEngine and front coverage.

## Validation

- Focused tab/ownership Core, registry/actions, Codex-pipe, MCP, and shutdown coverage: passed,
  7 files / 75 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 659 files / 4,864 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the tab collection Core, owner-facade delegation, lifecycle tests, direct-import rule, and
bundle candidate together. Per-owner tab maps and listeners must not return to Electron windows or
transport connection state.

## Remaining boundary

Browser registry and tab ownership are now host neutral; the Electron facade owns only window/tab
creation, navigation, and hardening. Broader live provider/repository paths and real
Linux/SSH/Feishu/provider acceptance remain.
