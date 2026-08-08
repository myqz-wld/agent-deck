# Recent 3 Days Changelogs

## Scope

This bucket contains only changelogs that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `changed_at` is within the last 3 days, inclusive |
| `recent-week` | `changed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `changed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `changed_at` is older than 30 days, or missing a parseable date |

## Index Table

| changed_at | File | Summary (<= 80 chars) |
|---|---|---|
| 2026-08-08 | `CHANGELOG_436_handoff-lifecycle-context-v2.md` | Harden handoff context, ownership, and large-capture handling |
| 2026-08-05 | `CHANGELOG_435_single-reviewer-finding-verification.md` | Verify un-rebutted single-worker findings before use |
| 2026-08-05 | `CHANGELOG_434_adapter-runtime-event-fidelity.md` | Refresh runtimes and restore native-agent/tool visibility |
