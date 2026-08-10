---
changelog_id: 556
changed_at: 2026-08-05
---

# CHANGELOG_556_provider-adapter-context-port-boundary: Port provider context ownership

## Summary

Provider adapters now receive structural hook-server and route-registry ports instead of desktop
concrete classes. One immutable, Electron-free context factory is shared by desktop composition and
the forthcoming Server Core provider host.

## Provider context contract

- Replaced the concrete `HookServer` and `RouteRegistry` declarations in `AdapterContext` with the
  minimal live listener and route-registration interfaces that providers actually consume.
- Kept live hook-server and route-registry object identity while snapshotting and freezing provider
  path values in `createProviderAdapterContext`.
- Exported the new ports through the stable adapter type facade without changing provider IDs,
  runtime behavior, hook routes, or Local/Remote source semantics.

## Codex bridge boundary

- Replaced the remaining concrete hook-server types in Codex bridge options, client-registry
  construction, and MCP configuration injection with the shared provider listener port.
- Preserved live `isRunning`, port, hook token, and MCP token reads; no token or server lifecycle
  ownership moved into the provider Core.
- Added architecture prohibitions that prevent the contract and factory from importing desktop hook
  implementations, stores, runtime hosts, logger utilities, Electron, or electron-log.

## Validation

- Focused provider context/runtime/adapter and Codex MCP/client coverage passed: 5 files / 26 tests.
- Node and web TypeScript plus architecture gates passed with 99 executable Node 22 candidates.
- `mise exec -- pnpm build` passed; the main production bundle transformed 796 modules.
- Canonical Electron full suite passed: 745 files plus 1 skipped / 5045 tests plus 1 skipped.
- `git diff --check` passed, changed ordinary TS/TSX files remain below 500 lines, and the cached Git
  index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the structural listener/registry ports, immutable context factory, Codex type migration,
architecture rules, executable Node candidate, and focused regression together. Removing any one
would either restore the desktop type dependency or leave the headless composition seam unproved.

## Remaining boundary

The next target is the concrete headless Claude/Codex/Grok host backed by explicit provider-settings
and session-repository ports, followed by composition into the injected Server Core runtime module.
Real Linux/native packaging and live provider acceptance remain environment gates.
