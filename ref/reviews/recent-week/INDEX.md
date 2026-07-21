# Recent Week Reviews

## Scope

This bucket contains only reviews that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `reviewed_at` is within the last 3 days, inclusive |
| `recent-week` | `reviewed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `reviewed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `reviewed_at` is older than 30 days, or missing a parseable date |

## Index Table

| reviewed_at | File | Topic | Severity Distribution |
|---|---|---|---|
| 2026-07-16 | `REVIEW_164_checkpoint-partial-progress-logging.md` | Checkpoint partial-progress log classification | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-15 | `REVIEW_163_checkpoint-patch-reduction.md` | Deterministic checkpoint patch reduction | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-15 | `REVIEW_162_runtime-log-signal-and-recovery.md` | Runtime log signal, checkpoint recovery, and navigation containment | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-14 | `REVIEW_161_handoff-ownership-plan-review-hardening.md` | Current-owner authority and plan-review lifecycle | 0 CRITICAL / 5 HIGH fixed / 13 MEDIUM fixed / 5 LOW fixed |
| 2026-07-14 | `REVIEW_160_checkpoint-lifecycle.md` | Automatic bounded continuation checkpoints | 0 CRITICAL / 3 HIGH fixed / 5 MEDIUM fixed / 6 LOW fixed |
| 2026-07-14 | `REVIEW_159_present-plan-lifecycle.md` | Blocking plan gate and isolated review fork | 0 CRITICAL / 0 HIGH / 5 MEDIUM fixed / 1 LOW fixed |
| 2026-07-14 | `REVIEW_158_handoff-context-coverage.md` | Runtime persistence and hand-off context coverage | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW residual |
