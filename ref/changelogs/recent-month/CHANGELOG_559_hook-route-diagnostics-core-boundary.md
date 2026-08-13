---
changelog_id: 559
changed_at: 2026-08-05
---

# CHANGELOG_559_hook-route-diagnostics-core-boundary: Port hook route diagnostics

## Summary

The shared hook route state machine no longer owns the desktop logger or process run identifier.
Diagnostics and route construction are executable Node cores, while one desktop host supplies the
existing logger/run-correlation singleton. Grok hook routes now require that port explicitly.

## Hook diagnostics Core

- Removed desktop logger and run-context imports from `route-diagnostics.ts`.
- Kept bounded suppression, safe labels, hashed session signatures, failure categorization,
  recovery summaries, stable HTTP bodies, origin parsing, and external-process attribution intact.
- Made route diagnostics an explicit required input to `createHookRoute`; direct Core construction
  defaults only to contained no-op sinks when a caller constructs a diagnostic state machine.

## Desktop host

- Added `route-diagnostics-host.ts` to own the scoped logger and process-run correlation source.
- Wired HookServer plus Claude, Codex, and desktop Grok routes to the same host singleton.
- Added a host regression proving the desktop logger receives bounded context and the run id without
  exposing raw error details.

## Grok route Core

- Removed the desktop diagnostics singleton import from `buildGrokHookRoutes`.
- Required the aggregate host to pass diagnostics explicitly, preserving the exact 14 installed
  events, route URLs, payload validation, source/origin tags, stable errors, and emit behavior.

## Enforced boundary

- Added shared hook diagnostics and Grok hook routes as the 102nd and 103rd executable Node 22
  boundary candidates.
- Added architecture prohibitions against the desktop diagnostics host, runtime/session/store/utils,
  desktop Grok composition, Electron, and electron-log.

## Validation

- Focused shared/Grok/Claude/Codex route, server, desktop-host, and adapter-host coverage passed:
  7 files / 26 tests.
- Node and web TypeScript plus architecture gates passed with 103 executable candidates.
- `mise exec -- pnpm build` passed; the main bundle transformed 796 modules.
- Canonical Electron full suite passed: 747 files plus 1 skipped / 5048 tests plus 1 skipped.
- The cached Git index remains empty; no shared development or Electron process was stopped,
  restarted, or signalled.

## Do Not Split Protection

Keep the Core defaults, required route input, desktop singleton host, all four consumer migrations,
architecture rules, executable candidates, and host regression together. A partial migration would
either silently lose desktop diagnostics or pull desktop logger ownership back into Linux bundles.

## Remaining boundary

The Grok hook integration graph is now headless-capable. Next construct the complete Grok aggregate
host from explicit settings, SessionManager, bridge runtime, resource, hook, diagnostics, and summary
ports, without importing desktop singleton facades.
