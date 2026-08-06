---
changelog_id: 485
changed_at: 2026-08-05
---

# CHANGELOG_485_claude-runtime-metadata-host-boundary: Port runtime observations to Core

## Summary

Claude runtime model/effort observation no longer owns the desktop session repository, application
event bus, or logger. A host-neutral Core now resolves aliases, validates effort, updates live state,
and decides best-effort persistence while one desktop host performs the side effects.

## Host-neutral metadata Core

- Added `runtime-metadata-core.ts` with Claude alias resolution, non-sensitive Gateway alias mapping,
  effort validation, in-memory observation, and changed-value persistence decisions.
- Preserved the critical ordering that live runtime state updates before any database access.
- Kept persistence and diagnostics failure-isolated so init/status frames and Stop hooks cannot alter
  provider control flow.

## Thin desktop host and facade

- Added `runtime-metadata-host.ts` as the sole owner of session reads/writes, updated-row publication,
  and scoped diagnostics.
- Kept the stable resolver, sync functions, and SDK Stop/StopFailure hook API unchanged.
- Moved the Gateway alias contract into Core and retained its existing type-only export from bridge
  types.

## Executable boundary gate

- Added a direct-import rule rejecting the stable sync facade, desktop host, bridge session types,
  event bus, runtime/session/store utilities, Node built-ins, Electron, and electron-log from Core.
- Added Claude runtime metadata Core as the fiftieth executable Node 22 boundary candidate.

## Validation

- Focused Core, host, existing metadata hook, usage translation, and gateway settings coverage:
  passed, 5 files / 29 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 667 files / 4,876 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the metadata Core, desktop host, stable SDK hook facade, alias type bridge, direct regressions,
import rule, and bundle candidate together. Runtime observations must update live state before
best-effort persistence and must never affect whether Claude is allowed to stop.

## Remaining boundary

Claude runtime metadata decisions are now host neutral. Larger session lifecycle/repository seams and
real Linux/SSH/Feishu/provider acceptance remain.
