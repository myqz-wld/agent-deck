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
| 2026-09-28 | `CHANGELOG_650_macos-installer-process-identity.md` | Require explicit app shutdown and verify exact macOS process identities |
| 2026-09-28 | `CHANGELOG_649_provider-runtime-stable-refresh.md` | Refresh stable Claude, Codex, protocol SDKs, and macOS bundled runtimes |
