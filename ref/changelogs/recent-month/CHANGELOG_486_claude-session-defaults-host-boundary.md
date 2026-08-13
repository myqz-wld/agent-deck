---
changelog_id: 486
changed_at: 2026-08-05
---

# CHANGELOG_486_claude-session-defaults-host-boundary: Port create defaults to Core

## Summary

Claude create/resume model, sandbox, effort, and Gateway profile resolution no longer read desktop
repositories or settings from their decision modules. One host-neutral Core owns precedence while a
single desktop host provides each live persisted/default/profile lookup.

## Host-neutral defaults Core

- Added `session-defaults-core.ts` with explicit/persisted/profile model selection, explicit/
  persisted/global sandbox selection, explicit/persisted effort selection, and Gateway option
  materialization.
- Preserved lazy settings reads, independent per-call persisted reads, profile model fallback, and
  the exact `off`/undefined defaults.
- Moved the resolved Gateway profile contract into Core while retaining the existing type export.

## Thin desktop host and facades

- Added `session-defaults-host.ts` as the sole owner of session repository reads, the global sandbox
  setting, and filesystem-backed Gateway profile resolution.
- Kept the stable model, sandbox, and Gateway option functions; added a matching effort resolver and
  removed the inline persisted-effort branch from the create orchestrator.
- Kept lookup failures inside the existing create-session preparation boundary so rollback and
  visible error behavior remain unchanged.

## Executable boundary gate

- Added a direct-import rule rejecting all four stable resolvers, the desktop host, Gateway profile
  filesystem module, event/runtime/session/store utilities, Node built-ins, Electron, and
  electron-log from Core.
- Added Claude session defaults Core as the fifty-first executable Node 22 boundary candidate.

## Validation

- Focused defaults Core/host, model/runtime selection, Gateway profiles, create failure cleanup, and
  recovery coverage: passed, 7 files / 58 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 669 files / 4,879 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the defaults Core, desktop host, four stable resolution entry points, profile type bridge,
direct regressions, import rule, and bundle candidate together. Each resolver must continue reading
live persisted/default state independently; do not introduce a cross-call cache.

## Remaining boundary

Claude create-session defaults are now host neutral. Larger lifecycle/repository seams and real
Linux/SSH/Feishu/provider acceptance remain.
