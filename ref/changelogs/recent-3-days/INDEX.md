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
| 2026-08-27 | `CHANGELOG_632_session-command-system-feedback.md` | Show one final system status for silent native commands |
| 2026-08-27 | `CHANGELOG_631_adapter-session-commands.md` | Add native adapter slash commands to Local and Remote composers |
| 2026-08-24 | `CHANGELOG_630_session-authoring-interaction-stability.md` | Stabilize trust, History reactivation, and expanded composer actions |
| 2026-08-24 | `CHANGELOG_629_session-settings-clarity.md` | Clarify project trust, Hook actions, and Codex SessionEnd timeout |
| 2026-08-24 | `CHANGELOG_628_native-project-trust.md` | Add native project trust to Local and Remote session creation |
