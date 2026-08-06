---
changelog_id: 560
changed_at: 2026-08-05
---

# CHANGELOG_560_grok-aggregate-host-core: Compose the headless Grok host

## Summary

One immutable Node factory now constructs the complete concrete Grok `AgentAdapter` host from
explicit provider settings, SessionManager, bridge runtime, resources, hook diagnostics, installer
observation, and adapter diagnostics. Desktop uses that same factory instead of a parallel object.

## Aggregate host Core

- Added `GrokBuildProviderSettingsPort`, including live adapter settings and bounded summary
  settings, with no settings-store discovery.
- Added explicit resource and adapter-diagnostic ports plus required bridge runtime, SessionManager,
  hook route diagnostics, and hook installer observer inputs.
- Constructs the concrete `GrokBuildBridge`, hook installer, exact route surface, and bounded summary
  runner behind one frozen `GrokBuildAdapterHost` and one frozen bridge host.
- Added tests for immutable construction, concrete bridge identity, exact port delegation, exact 14
  hook routes, hook installer ownership, diagnostic delegation, and the empty-summary short circuit.

## Desktop composition

- Replaced the hand-written desktop Grok bridge/adapter host objects with
  `createGrokBuildAdapterHost`.
- Kept settings-store, SessionManager, event/runtime bridge, resources, hook singleton, logger, and
  summary values in the desktop file and passed them as explicit ports.
- Preserved the exported `desktopGrokAdapterHost` bridge seam and the public adapter singleton.

## Enforced boundary

- Added the aggregate host as the 104th executable Node 22 boundary candidate.
- Added architecture prohibitions against desktop adapter/runtime/hook/resource/summary hosts,
  desktop settings/event/logger ownership, Electron, and electron-log.
- The factory imports concrete Core implementations only; future Linux composition supplies values
  without importing desktop singleton facades.

## Validation

- Focused aggregate/desktop/bridge/hook/summary coverage passed: 6 files / 20 tests.
- Node and web TypeScript plus architecture gates passed with 104 executable candidates.
- `mise exec -- pnpm build` passed; the main bundle transformed 795 modules.
- Canonical Electron full suite passed: 748 files plus 1 skipped / 5050 tests plus 1 skipped.
- The cached Git index remains empty; no shared development or Electron process was stopped,
  restarted, or signalled.

## Do Not Split Protection

Keep the aggregate port contract, concrete construction, immutable outputs, desktop migration,
singleton prohibitions, executable candidate, and exact-route tests together. A second hand-written
host would allow desktop and Linux behavior to drift; importing desktop values would defeat the
headless boundary.

## Remaining boundary

Repeat this aggregate value-host composition for Claude and Codex, then supply concrete headless
settings/session/repository values and compose the injected Server Core runtime bootstrap.
