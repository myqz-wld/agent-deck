# Recent 3 Days Reviews

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
| 2026-08-27 | `REVIEW_265_system-status-session-readiness.md` | System status and Claude startup consistency | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 2 LOW fixed |
| 2026-08-24 | `REVIEW_264_session-authoring-interaction-stability.md` | Session authoring and History interaction stability | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-08-24 | `REVIEW_263_session-settings-clarity.md` | Session settings clarity and Hook timeout | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 3 LOW fixed |
| 2026-08-24 | `REVIEW_262_native-project-trust.md` | Native project trust security and lifecycle | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed / 2 LOW fixed |
| 2026-08-23 | `REVIEW_261_session-config-read-latency.md` | Session config read latency | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-08-21 | `REVIEW_260_global-async-navigation-readiness.md` | Global asynchronous navigation readiness | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed / 1 LOW fixed |
