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
| 2026-07-12 | `PLAN_7_storage-maintenance-worker-provider-compaction.md` | completed | Isolate live storage maintenance and restore compact generation | CHANGELOG_362 / REVIEW_153 |
| 2026-07-11 | `PLAN_6_storage-performance-observability-svg-icons.md` | completed | Stage storage maintenance and unify renderer SVG icons | CHANGELOG_361 / REVIEW_152 |
| 2026-07-11 | `PLAN_5_unified-continuation-context.md` | completed | Unify provider-neutral continuation context | CHANGELOG_358 / REVIEW_148 |
| 2026-07-11 | `PLAN_4_session-pinning-reviewer-model.md` | completed | Add persistent Live pins and Codex reviewer default | CHANGELOG_359 / REVIEW_149 |
| 2026-07-10 | `PLAN_3_codex-collaboration-raw-events.md` | completed | Restore fresh Codex collaboration events | REVIEW_147 |
| 2026-07-09 | `PLAN_2_spawn-session-native-fork.md` | completed | Add safe provider-native parallel forks | CHANGELOG_353 / REVIEW_144 |
| 2026-07-09 | `PLAN_1_project-engineering-foundation.md` | completed | Align Repository Engineering Foundation | CHANGELOG_349 |
