# Recent 3 Days Plans

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
| 2026-07-14 | `PLAN_9_runtime-controls-handoff-context.md` | completed | Auto-save runtime controls and restore hand-off coverage | CHANGELOG_363 / REVIEW_158 |
| 2026-07-12 | `PLAN_8_core-snapshot-ui-copy-review.md` | completed | Audit core snapshots and simplify user-facing copy | REVIEW_154 |
| 2026-07-12 | `PLAN_7_storage-maintenance-worker-provider-compaction.md` | completed | Isolate live storage maintenance and restore compact generation | CHANGELOG_362 / REVIEW_153 |
| 2026-07-11 | `PLAN_6_storage-performance-observability-svg-icons.md` | completed | Stage storage maintenance and unify renderer SVG icons | CHANGELOG_361 / REVIEW_152 |
| 2026-07-11 | `PLAN_5_unified-continuation-context.md` | completed | Unify provider-neutral continuation context | CHANGELOG_358 / REVIEW_148 |
| 2026-07-11 | `PLAN_4_session-pinning-reviewer-model.md` | completed | Add persistent Live pins and Codex reviewer default | CHANGELOG_359 / REVIEW_149 |
