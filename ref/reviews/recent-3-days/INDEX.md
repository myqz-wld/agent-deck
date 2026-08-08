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
| 2026-08-08 | `REVIEW_216_handoff-lifecycle-context-v2.md` | Handoff context and ownership hardening | 0 CRITICAL / all HIGH+MEDIUM fixed / 1 LOW accepted / 6 residuals |
| 2026-08-05 | `REVIEW_215_adapter-event-and-collaboration-compatibility.md` | Current adapter event and native-agent contracts | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed / 1 INFO confirmed |
