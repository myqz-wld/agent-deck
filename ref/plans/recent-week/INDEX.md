# Recent Week Plans

## Scope

This bucket contains only plans that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `Completed At` or `completed_at` is within the last 3 days, inclusive |
| `recent-week` | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date |

## Index Table

| Completed At | Plan | Status | Summary | Related Final Record |
|---|---|---|---|---|
| 2026-07-15 | `PLAN_14_checkpoint-patch-reduction.md` | completed | Let the LLM emit semantic patches while code owns checkpoint state | REVIEW_163 |
| 2026-07-15 | `PLAN_13_history-search-case-insensitive.md` | completed | Rebuild History FTS case-insensitively while fully offline | CHANGELOG_374 |
| 2026-07-14 | `PLAN_12_handoff-ownership-plan-review-hardening.md` | completed | Preserve current-owner authority and harden plan-review lifecycle | CHANGELOG_366 / REVIEW_161 |
| 2026-07-14 | `PLAN_11_automatic-continuation-checkpoints.md` | completed | Keep continuation state fresh without unbounded growth | CHANGELOG_365 / REVIEW_160 |
| 2026-07-14 | `PLAN_10_present-plan-deep-review.md` | completed | Retain blocking plan gates and add isolated contextual review | CHANGELOG_364 / REVIEW_159 |
| 2026-07-14 | `PLAN_9_runtime-controls-handoff-context.md` | completed | Auto-save runtime controls and restore hand-off coverage | CHANGELOG_363 / REVIEW_158 |
