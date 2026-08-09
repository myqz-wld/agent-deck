---
changelog_id: 548
changed_at: 2026-08-05
---

# CHANGELOG_548_claude-recovery-diagnostic-host-injection: Inject recovery diagnostics

## Summary

The Claude disconnect-recovery orchestrator no longer imports the desktop logger. Its existing
required recovery host now owns event-history freshness reads and bounded recovery diagnostics.

## Recovery diagnostic ownership

- Extended `ClaudeRecoveryFreshnessHost` with the required recovery warning port.
- Moved the scoped recoverer logger into the concrete desktop host beside the existing event-history
  timestamp ownership.
- Threaded the warning port through adapter initialization, the bridge facade, `SessionRecoverer`,
  and the free-function dependency bundle.
- Routed capture, cwd fallback, archived-session restoration, JSONL fallback, cancellation, and
  continuation-cleanup diagnostics through one best-effort Core guard.
- Expanded the recovery architecture rule to reject all direct desktop utility imports.

## Preserved recovery behavior

- Native JSONL resume still bypasses paid continuation preparation and fresh-session construction.
- Missing or stale native history still uses the immutable captured continuation and the exact
  application/CLI session identity policy.
- Cwd fallback, archived-session unarchive, single-flight locking, and close-epoch cancellation keep
  their existing order and authority.
- Capture failure remains non-authoritative while native history is usable; cleanup failure remains
  secondary after recovery completes.
- User-message/error publication and closed-session rollback behavior are unchanged.

## Direct evidence

- New recoverer tests inject a warning observer that throws and prove capture and cleanup
  diagnostics cannot change a successful native recovery result.
- The desktop-host test proves timestamp reads and scoped warnings stay behind the same concrete
  host.
- Existing recovery, JSONL fallback, adapter-init, cancellation, archive, and lifecycle suites retain
  the complete state-machine coverage.

## Validation

- Focused recovery/host/init coverage: passed, 6 files / 54 tests.
- Complete Claude adapter coverage: passed, 127 files / 504 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 739 files / 5,036 tests plus 1 skipped.
- `recover-and-send-impl.ts` is 498 lines and `sdk-bridge/index.ts` is 499 lines.
- The cached Git index remains empty; no shared development or Electron process was touched.

## Do Not Split Protection

Keep the required host warning port, bridge/recoverer threading, best-effort guard, architecture
prohibition, desktop binding, and throwing-observer regressions together. Partial migration could
either restore desktop discovery in Core or make diagnostics authoritative for recovery outcomes.

## Remaining boundary

`create-session/create-session-impl.ts` still imports a desktop utility for safe diagnostic text.
The next bounded slice should move that pure redaction boundary into an explicit Node Core without
changing startup failure classification, rollback, user-visible copy, or log disclosure limits.
