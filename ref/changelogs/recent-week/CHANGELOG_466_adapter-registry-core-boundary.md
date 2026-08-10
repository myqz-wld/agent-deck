---
changelog_id: 466
changed_at: 2026-08-05
---

# CHANGELOG_466_adapter-registry-core-boundary: Separate provider registry diagnostics

## Summary

The provider lifecycle registry no longer imports the desktop logger, run identity, safe diagnostic
serializer, or log-state tracker. The registry is now a host-neutral Core boundary with an explicit
diagnostics port, while the existing desktop facade preserves production diagnostics and singleton
composition.

## Host-neutral registry

- Moved registration, lookup, insertion-ordered initialization and shutdown, compile-time adapter
  identity checks, result contracts, and exact thrown-value preservation into `registry-core.ts`.
- Added an injectable semantic diagnostics port with a no-op Core default, so diagnostic failures
  cannot change provider lifecycle order or results.
- Kept the public `registry.ts` facade and singleton stable; desktop composition now supplies
  `DesktopAdapterRegistryDiagnostics` explicitly.

## Desktop diagnostic preservation

- Moved the bounded two-key state tracker, five-minute summaries, init/shutdown slow thresholds,
  run identity, safe serialization, logger containment, recovery messages, and count caps into
  `registry-diagnostics.ts` without changing their observable behavior.
- Retained the existing twenty-one desktop diagnostic regressions and added a Core-port regression
  proving aggregate counts, elapsed-start forwarding, and raw error identity.

## Executable boundary gate

- Added a direct-import architecture rule rejecting the desktop facade, diagnostics adapter,
  runtime host, stores, desktop utilities, Electron, and Node built-ins from the Core registry.
- Added the provider registry as the thirty-first executable Node 22 boundary candidate.

## Validation

- Focused registry and bootstrap coverage: passed, 4 files / 34 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 632 files / 4,822 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the registry Core, semantic diagnostics port, desktop diagnostics adapter, stable facade,
behavior-preservation tests, direct-import rule, and executable bundle gate together. The Core
registry must not regain implicit desktop logging or process-state dependencies.

## Remaining boundary

Provider lifecycle orchestration is now host neutral, but concrete provider settings/repository
composition, Browser registry ownership, target Linux/native packaging, and live SSH/Feishu/provider
acceptance remain. Those external acceptance surfaces are not claimed by this deterministic slice.
