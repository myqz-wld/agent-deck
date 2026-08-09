---
changelog_id: 557
changed_at: 2026-08-05
---

# CHANGELOG_557_provider-adapter-set-core-boundary: Construct isolated provider sets

## Summary

Provider runtime composition no longer imports the three desktop adapter singleton indexes. A pure
Node factory constructs one isolated Claude/Codex/Grok adapter set from explicit aggregate hosts,
giving desktop and the forthcoming Server Core runtime the same value-composition boundary.

## Provider set Core

- Added `createProviderAdapterSet` with required Claude, Codex, and Grok host inputs and a stable
  provider order.
- Returns named provider instances plus one immutable adapter collection so independent runtime
  owners cannot accidentally share live bridges, queues, tokens, or lifecycle state.
- Added tests for exact provider identity/order, immutable output, and separate runtime instances.

## Desktop composition

- Replaced `provider-runtime-host.ts` imports of the Claude/Codex/Grok singleton facades with direct
  desktop host values passed through the shared provider-set factory.
- Preserved the existing registry, partial initialization, session close/rename hooks, diagnostics,
  provider capabilities, and public singleton facades for compatibility.
- Updated the bootstrap ordering test to mock the provider-runtime composition seam instead of the
  retired singleton-import seam.

## Enforced boundary

- Added the provider-set factory as the 100th executable Node 22 boundary candidate.
- Added architecture prohibitions against desktop adapter hosts/facades, provider-runtime host,
  session/store/runtime/logger ownership, Electron, and electron-log.
- This slice changes no protocol, IPC contract, renderer behavior, or Local/Remote source semantics.

## Validation

- Focused provider set/context/adapter/runtime/bootstrap coverage passed: 5 files / 17 tests; the
  repaired bootstrap-specific regression passed: 3 files / 10 tests.
- Node and web TypeScript plus architecture gates passed with 100 executable candidates.
- `mise exec -- pnpm build` passed; the main bundle transformed 794 modules after removing the
  runtime composition's unused singleton facade graph.
- Canonical Electron full suite passed: 746 files plus 1 skipped / 5047 tests plus 1 skipped.
- `git diff --check` passed, changed ordinary TS/TSX files remain below 500 lines, and the cached Git
  index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the provider-set factory, desktop value-host wiring, singleton-import prohibitions, bootstrap
mock migration, executable candidate, and isolation tests together. Dropping any one could restore
hidden shared provider state or leave Server Core composition dependent on desktop facades.

## Remaining boundary

The next target is the headless implementation of the Claude/Codex/Grok aggregate hosts over
explicit provider-settings and session-repository ports, then the injected Server Core runtime
bootstrap. Real Linux/native packaging and live provider acceptance remain environment gates.
