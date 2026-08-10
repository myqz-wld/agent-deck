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
| 2026-08-05 | `REVIEW_215_adapter-event-and-collaboration-compatibility.md` | Current adapter event and native-agent contracts | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed / 1 INFO confirmed |
| 2026-08-04 | `REVIEW_214_diff-history-and-runtime-diagnostics.md` | Diff freshness and runtime log signal | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed / 2 LOW fixed |
