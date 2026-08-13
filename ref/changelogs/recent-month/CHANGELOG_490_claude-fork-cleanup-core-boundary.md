---
changelog_id: 490
changed_at: 2026-08-05
---

# CHANGELOG_490_claude-fork-cleanup-core-boundary: Port discard aggregation

## Summary

Claude native-fork discard no longer owns the desktop logger or diagnostic redactor. A host-neutral
Core owns exactly-once cleanup, source-identity protection, exhaustive phase execution, and residual
failure aggregation while a desktop observer records safe diagnostics.

## Host-neutral cleanup Core

- Added `fork-session-cleanup-core.ts` with memoized discard, application/native source fences, row
  inspection, provider close, application-row deletion, and native-session deletion.
- Preserved the rule that all cleanup phases are attempted even after earlier failures and that the
  resulting `ClaudeForkDiscardError` carries only phase/target metadata plus the bounded residual
  state marker.
- Kept the production store, SDK, close, and coordinated-delete operations as explicit ports and
  made diagnostic failure non-authoritative.

## Thin desktop observer and facade

- Added `fork-session-cleanup-host.ts` as the sole owner of logger and `safeDiagnostic` projection.
- Reduced the stable cleanup module to type/error re-exports plus one typed Core/observer wrapper;
  existing `instanceof ClaudeForkDiscardError` behavior remains unchanged.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop observer, fork orchestrator,
  runtime/session/store/event/diagnostic utilities, Node built-ins, Electron, and electron-log from
  Core.
- Added Claude fork cleanup Core as the fifty-fifth executable Node 22 boundary candidate.

## Validation

- Focused Core/observer, family-fork, and adapter coverage: passed, 4 files / 20 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-five Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 676 files / 4,893 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep cleanup Core, desktop observer, stable facade, family-fork caller, error identity, direct-import
rule, and exhaustive/memoization tests together. A failed phase must not skip later phases, a second
discard must reuse the first result, and source identities must never enter child cleanup.

## Remaining boundary

Claude fork discard policy is now host neutral. Transcript discovery and native-fork creation,
message/permission processing, recovery orchestration, and real Linux/SSH/Feishu/provider acceptance
remain.
