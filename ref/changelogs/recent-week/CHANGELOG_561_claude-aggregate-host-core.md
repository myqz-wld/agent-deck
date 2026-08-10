---
changelog_id: 561
changed_at: 2026-08-05
---

# CHANGELOG_561_claude-aggregate-host-core: Compose the headless Claude host

## Summary

One immutable Node factory now constructs the complete Claude `AgentAdapter` host from an explicit
bridge value, native-fork host, hook diagnostics, hook installer observation, fork-safety policy,
and summary runner. Desktop uses that same factory instead of a parallel aggregate object.

## Aggregate host Core

- Added explicit fork-safety and summary ports plus required bridge, fork, hook route diagnostics,
  and hook installer observer inputs.
- Clones and freezes the complete Claude bridge host, then freezes the returned
  `ClaudeCodeAdapterHost` so composition cannot mutate provider authority after construction.
- Constructs `HookInstallerCore`, registers the exact 16 Claude hook routes, delegates native-fork
  admission, and delegates bounded provider summaries without discovering desktop singletons.
- Added tests for immutable construction, bridge value identity, exact delegation, installer
  ownership, and the complete route surface.

## Desktop composition

- Replaced the hand-written desktop Claude aggregate object with `createClaudeCodeAdapterHost`.
- Kept settings-store, SessionManager, concrete bridge constructor, native-fork storage/SDK,
  gateway-path policy, hook diagnostics/logger, and summary runtime in the desktop file as explicit
  values.
- Preserved `desktopClaudeAdapterInitHost`, `desktopClaudeCodeAdapterHost`, and the public adapter
  singleton seams.

## Enforced boundary

- Removed the desktop hook-diagnostics default from `buildHookRoutes`; every caller now supplies
  the intended diagnostics value.
- Added the Claude aggregate host and Claude hook routes as the 105th and 106th executable Node 22
  boundary candidates.
- Added architecture prohibitions against desktop adapter, fork, gateway, hook, summary, settings,
  SessionManager, logger, Electron, and electron-log ownership.

## Validation

- Focused aggregate/desktop/hook coverage passed: 5 files / 13 tests.
- Node and web TypeScript plus architecture gates passed with 106 executable candidates.
- `mise exec -- pnpm build` passed; the main bundle transformed 795 modules.
- Canonical Electron full suite passed: 749 files plus 1 skipped / 5052 tests plus 1 skipped.
- The cached Git index remains empty; no shared development or Electron process was stopped,
  restarted, or signalled.

## Do Not Split Protection

Keep the aggregate port contract, immutable bridge/host values, exact hook diagnostics, desktop
migration, singleton prohibitions, executable candidates, and route tests together. A second
hand-written Claude host would allow desktop and Linux behavior to drift.

## Remaining boundary

Repeat this aggregate value-host composition for Codex, then supply concrete headless
settings/session/repository values and compose the injected Server Core runtime bootstrap.
