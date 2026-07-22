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
| 2026-07-22 | `CHANGELOG_381_pending-image-previews.md` | Show pending image details and full-size previews in composers |
| 2026-07-22 | `CHANGELOG_380_node-repl-sandbox-compatibility.md` | Bridge legacy node_repl sandbox metadata and refresh agent runtimes |
| 2026-07-21 | `CHANGELOG_379_plan-review-pending-queue-composer.md` | Isolate plan review and preserve pending input until consumption |
