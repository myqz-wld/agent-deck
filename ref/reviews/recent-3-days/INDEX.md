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
| 2026-08-18 | `REVIEW_254_summary-settings-layout-and-timeout-policy.md` | Summary settings layout and timeout policy | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed |
| 2026-08-18 | `REVIEW_253_current-only-gap-sweep.md` | Current-only coverage-gap sweep | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 3 LOW fixed |
| 2026-08-17 | `REVIEW_252_current-only-compatibility-sweep.md` | Current-only compatibility sweep | 0 CRITICAL / 0 HIGH / 6 MEDIUM fixed / 2 LOW fixed |
| 2026-08-15 | `REVIEW_251_remote-profile-schema-migration.md` | Remote profile startup migration | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-08-15 | `REVIEW_250_interruptible-reconnect-and-session-readiness.md` | Interruptible reconnect and session readiness | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
