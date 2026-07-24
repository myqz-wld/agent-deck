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
| 2026-07-23 | `PLAN_16_grok-build-adapter-profiles.md` | completed | Add Grok Build through ACP and typed adapter runtime profiles | CHANGELOG_382 / REVIEW_167 |
| 2026-07-21 | `PLAN_15_plan-review-pending-queue-composer.md` | completed | Isolate review, queue pending input, and expand the composer | CHANGELOG_379 / REVIEW_165 |
