---
changelog_id: 562
changed_at: 2026-08-05
---

# CHANGELOG_562_codex-aggregate-host-core: Compose the headless Codex host

## Summary

One immutable Node factory now constructs the complete Codex `AgentAdapter` host from an explicit
bridge, hook ports, provider resolver, and summary runner. Codex hook installation and routes no
longer discover desktop logger, process-filter, SQLite, or diagnostics singletons.

## Aggregate host Core

- Added an explicit provider resolver and an aggregate summary port containing settings, hardened
  oneshot execution, and event formatting.
- Clones and freezes the complete Codex bridge host, then freezes the returned
  `CodexCliAdapterHost`.
- Constructs the hook installer, registers the exact 11 Codex hook routes, resolves configured
  providers, and runs the bounded summary Core without desktop singleton discovery.
- Added tests for immutable construction, bridge identity, provider resolution, summary option
  precedence, installer ownership, and the exact route surface.

## Hook ownership

- Added explicit hook filter, route diagnostics, open-tool reader, and reconciliation observer
  ports.
- Removed default imports of the desktop ephemeral-process filter, SQLite open-tool repository,
  desktop hook diagnostics, and logger from the route builder.
- Reconciliation failures remain best-effort: even a throwing observer cannot replace the
  authoritative terminal event.
- Replaced the installer logger with an injected observer whose failure cannot change the
  repairable “not installed” result.

## Desktop composition

- Replaced the hand-written desktop Codex aggregate object with `createCodexCliAdapterHost`.
- Kept settings-store, concrete bridge/runtime/recovery values, Desktop process filtering, SQLite
  history, hook diagnostics/logger, provider config, summary formatting, and oneshot execution in
  the desktop file as explicit ports.
- Preserved `desktopCodexAdapterInitHost`, `desktopCodexCliAdapterHost`, and the public singleton.

## Enforced boundary

- Added the Codex aggregate host, hook installer, and hook routes as the 107th through 109th
  executable Node 22 boundary candidates.
- Added architecture prohibitions against desktop adapter/filter/summary hosts, hook singleton,
  SessionManager/store/logger ownership, Electron, and electron-log.

## Validation

- Focused aggregate/desktop/hook/filter/summary coverage passed: 6 files / 34 tests.
- Node and web TypeScript plus architecture gates passed with 109 executable candidates.
- `mise exec -- pnpm build` passed; the main bundle transformed 795 modules.
- Canonical Electron full suite passed: 750 files plus 1 skipped / 5055 tests plus 1 skipped.
- The cached Git index remains empty; no shared development or Electron process was stopped,
  restarted, or signalled.

## Do Not Split Protection

Keep the aggregate contract, hook ports, contained observer failures, immutable values, desktop
migration, executable candidates, and exact-route tests together. Reintroducing default desktop
ports into the Core would make Linux composition non-deterministic.

## Remaining boundary

Supply concrete headless provider settings/session/repository values, then compose the three value
adapters with `provider-runtime-core` into the injected Server Core runtime bootstrap.
