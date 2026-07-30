---
plan_id: PLAN_24
title: Storage maintenance terminal timeout policy
status: completed
created_at: 2026-07-29
updated_at: 2026-07-29
completed_at: 2026-07-29
base_branch: codex/whole-project-quality-refresh-20260728
base_commit: d081621118c2870911e77e5bf7f6f625c1273dd7
completed_head: b60223507b80ae7bc2ca3c4da535c8b7ee1093f9
related_changelog: CHANGELOG_412
related_review: REVIEW_188
---

# PLAN_24_maintenance-timeout-terminal-policy: Disable until restart

## Goal

Implement the user-selected safe terminal policy for storage maintenance: after a worker request
times out, disable maintenance until app restart without terminating native code or respawning a
replacement in the same process.

## Invariants

- Never call `Worker.terminate()` or add another termination timer.
- Restore the main WAL autocheckpoint lease before relinquishing maintenance ownership.
- Send no more than one cooperative close after the timeout.
- Ignore stale worker work/results while still accepting definitive close/exit signals.
- Never spawn another worker from the same scheduler instance after terminal disable.
- Preserve the existing global 10-second shutdown race and third-connection gate.
- A fresh scheduler created by a new app run may resume from durable cursors.

## Completed steps

- [x] Re-read the exact-runtime B12c3 spike and current controller/lifecycle contracts.
- [x] Add failure-first coverage for every request type and late worker outcome.
- [x] Extract state-only diagnostics so the controller remains below 500 lines.
- [x] Add terminal disable, one-close fencing, lease restoration, stale-close settlement, and
      no-respawn guards.
- [x] Add the pending storage-stop 9,999/10,000 ms lifecycle regression.
- [x] Run focused Electron-ABI tests, full tests, typecheck, logger check, build, and static audits.
- [x] Archive the decision and implementation evidence.

## Validation result

- 3 focused files / 23 tests passed.
- 10 Electron-ABI maintenance/lifecycle files / 45 tests passed.
- 467 full-suite files passed plus one intentional skip; 4,003 tests passed plus one skip.
- Typecheck, logger check, production build, diff check, no-terminate scan, and LOC guard passed.

## Final status

Completed on 2026-07-29. Maintenance now fails safely closed for the current app run after any
request timeout. A permanently blocked native worker remains alive until process exit; that is the
deliberate limitation of option A.
