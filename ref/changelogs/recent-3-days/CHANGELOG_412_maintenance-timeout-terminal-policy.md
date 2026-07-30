---
changelog_id: 412
changed_at: 2026-07-29
---

# CHANGELOG_412_maintenance-timeout-terminal-policy: Disable unsafe maintenance recovery

## Summary

Disable storage maintenance for the rest of the current app run after its worker times out.
Recovery resumes from durable maintenance cursors after the next app start, without terminating a
worker that may be blocked inside native SQLite.

## Changes

- Treat the first `run-slice`, `checkpoint`, or `close` timeout as terminal for that scheduler
  instance.
- Restore the main connection's prior WAL autocheckpoint lease exactly once on the successful
  restore path.
- Queue at most one cooperative worker close. The terminal close has no second timeout and never
  escalates to `Worker.terminate()`.
- Suppress later maintenance requests and same-process worker respawn, including after late
  `closed`, `fatal`, `error`, or `exit` signals.
- Accept a terminal worker's definitive close signal even when its request correlation is stale,
  so a pending app shutdown can settle after the connection actually closes.
- Keep the existing global 10-second application shutdown boundary. A worker that never returns
  keeps shutdown pending until the app closes SQLite and forces process exit.
- Split state-only maintenance diagnostics from the worker lifecycle controller, reducing
  `scheduler.ts` from 500 to 492 lines without changing its existing progress/checkpoint logging.

## Validation

- Failure-first terminal-policy suite: 7/7 cases failed on the old respawn behavior.
- Focused terminal/lifecycle suites: 3 files / 23 tests passed.
- Electron-ABI maintenance and shutdown matrix: 10 files / 45 tests passed.
- Full Electron-ABI suite: 467 files passed and one intentional live smoke skipped; 4,003 tests
  passed and one skipped.
- `pnpm typecheck`
- `pnpm logger:check`
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

- Keep the terminal-disable flag, single cooperative-close fence, WAL lease restoration, stale
  close handling, no-respawn guards, and timeout tests together.
- Do not add a worker-thread termination fallback. Same-run forced recovery requires an isolated
  child-process design and a separate crash-recovery proof.
- All changed production files remain below 500 lines.

## Related records

- `REVIEW_188_maintenance-timeout-terminal-policy.md`
- `PLAN_24_maintenance-timeout-terminal-policy.md`
- `REVIEW_187_whole-project-quality-refresh.md`
