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
| 2026-08-23 | `CHANGELOG_625_provider-runtime-app-sync.md` | Refresh embedded provider runtimes and install the macOS app |
| 2026-08-23 | `CHANGELOG_624_session-config-read-latency.md` | Keep adapter-default reads inside the 150 ms UI grace |
| 2026-08-21 | `CHANGELOG_623_global-async-navigation-readiness.md` | Apply the 150 ms rule across asynchronous navigation |
| 2026-08-20 | `CHANGELOG_622_global-stable-action-presentation.md` | Stabilize dynamic actions and 150 ms configuration visuals globally |
| 2026-08-20 | `CHANGELOG_621_stable-session-create-action.md` | Keep the create action visually and geometrically stable |
| 2026-08-20 | `CHANGELOG_620_atomic-session-configuration-readiness.md` | Keep adapter configuration switches visually atomic for 150 ms |
