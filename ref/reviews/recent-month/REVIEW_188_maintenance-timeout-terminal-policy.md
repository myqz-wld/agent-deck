---
review_id: 188
reviewed_at: 2026-07-29
baseline_commit: d081621118c2870911e77e5bf7f6f625c1273dd7
reviewed_head: b60223507b80ae7bc2ca3c4da535c8b7ee1093f9
expired: false
---

# REVIEW_188_maintenance-timeout-terminal-policy: Safe terminal maintenance behavior

## Scope

The user selected option A from the B12c3 native-worker safety gate: disable maintenance until the
next app start after the first request timeout, without attempting worker-thread termination or
same-run replacement.

```review-scope
src/main/index/__tests__/checkpoint-shutdown-entry.test.ts
src/main/store/storage-maintenance/maintenance-scheduler.test.ts
src/main/store/storage-maintenance/maintenance-terminal-policy.test.ts
src/main/store/storage-maintenance/scheduler-diagnostics.ts
src/main/store/storage-maintenance/scheduler.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The old timeout path restored the main WAL lease and queued a close, but respawned a replacement after the old worker eventually closed. Adding `Worker.terminate()` is unsafe: the exact Electron/better-sqlite3 spike reproduced a process-level `SIGABRT` while a native statement was blocked. | Make timeout terminal for the scheduler instance. Restore the lease, queue one cooperative close without a second timer, suppress all later work/respawn, and permit only a newly constructed scheduler after app restart. |
| LOW | A native call that never returns can leave the old worker thread and SQLite connection alive until process exit. | Preserve this limitation explicitly. The global 10-second quit race still skips the third shutdown-only connection, closes the main DB best-effort, and forces exit 1. Same-run forced recovery remains out of scope unless maintenance moves to a child process. |

## Evidence

- Failure-first tests observed seven old-policy failures: run-slice and checkpoint timeouts spawned
  a second worker, close timeout queued a duplicate close, late fatal/exit/error paths respawned,
  and the same scheduler instance could start again.
- A second failure-first refinement proved that a definitive late `closed` message with stale
  correlation did not settle `stop()`. Terminal mode now treats close as generation-fenced
  connection closure rather than ordinary request data.
- The main WAL autocheckpoint fake records one successful restoration to its exact prior value.
- Timers advanced far beyond the retry/request windows without creating another request, close,
  or worker.
- The lifecycle test remains open at 9,999 ms, then at 10,000 ms skips `getDb()` and the
  shutdown-only maintenance runner, calls `closeDb()`, and selects `process.exit(1)`.
- Production has no `terminate` surface in the changed controller or diagnostics module.

## Validation

- Focused Vitest: 3 files / 23 tests passed.
- Electron-ABI storage/lifecycle matrix: 10 files / 45 tests passed.
- Full Electron-ABI suite: 467 files passed, one skipped; 4,003 tests passed, one skipped.
- Typecheck, logger check, production build, diff check, added-line archaeology scan, and
  production LOC audit passed.
- Production LOC: scheduler 492; diagnostics 96.

## Fixes landed

- `b6022350 fix(storage): disable maintenance after timeout`

## Residual risk

- If the timed-out native call never returns, maintenance remains disabled and that worker remains
  alive until app exit. This is the selected safe policy, not an in-process recovery claim.
- No live development restart was performed because the running Agent Deck instance owns this
  session. Automated lifecycle and production-build coverage passed.

## Follow-up

Only reopen terminal recovery if same-run recovery becomes a requirement. That work must use an
isolated child process and prove per-phase kill, WAL/transaction recovery, orphan prevention, and
packaged cross-platform termination semantics.
