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
| 2026-09-04 | `REVIEW_267_compatibility-dead-code-audit.md` | Compatibility and dead-code retirement | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW open |
| 2026-09-03 | `REVIEW_266_browser-runtime-remount.md` | Cross-day Browser runtime remount | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
