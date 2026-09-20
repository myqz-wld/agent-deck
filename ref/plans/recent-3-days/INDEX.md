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
| 2026-09-19 | `PLAN_54_gateway-model-presentation.md` | completed | Preserve live models and stabilize Gateway default reads | REVIEW_275 |
| 2026-09-16 | `PLAN_53_privacy-and-compatibility-cleanup.md` | completed | Scrub private history and retire obsolete compatibility | REVIEW_274 |
| 2026-09-16 | `PLAN_52_relay-worker-live-acceptance.md` | completed with installed acceptance pending | Verify Relay and repair packaged Worker startup | REVIEW_273 |
