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
| 2026-10-03 | `REVIEW_314_file-operation-cards.md` | Unify file cards and repair Monaco teardown | 1 MEDIUM / 1 LOW fixed |
| 2026-10-02 | `REVIEW_313_grok-queued-mid-turn-interjections.md` | Resume queued Grok corrections during active turns | 1 MEDIUM fixed; 25 new regressions passed |
| 2026-10-02 | `REVIEW_312_claude-mid-turn-streaming-input.md` | Restore mid-turn streaming and correlated input acceptance | 1 MEDIUM fixed; regression suite passed |
