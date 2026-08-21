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
| 2026-08-20 | `REVIEW_258_session-create-button-stability.md` | Session create-button presentation stability | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-08-20 | `REVIEW_257_session-creation-readiness-and-stall.md` | Session creation readiness and stall diagnostics | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed |
| 2026-08-19 | `REVIEW_256_iab-annotation-capture-race.md` | IAB annotation capture race remediation | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-18 | `REVIEW_255_unified-browser-boundary-review.md` | Unified Browser security and lifecycle boundaries | 0 CRITICAL / 0 HIGH / 0 MEDIUM / no open findings |
| 2026-08-18 | `REVIEW_254_summary-settings-layout-and-timeout-policy.md` | Summary settings layout and timeout policy | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed |
| 2026-08-18 | `REVIEW_253_current-only-gap-sweep.md` | Current-only coverage-gap sweep | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 3 LOW fixed |
| 2026-08-17 | `REVIEW_252_current-only-compatibility-sweep.md` | Current-only compatibility sweep | 0 CRITICAL / 0 HIGH / 6 MEDIUM fixed / 2 LOW fixed |
