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
| 2026-09-22 | `CHANGELOG_648_grok-native-model-selection.md` | Use native Grok defaults, discovery, and model-switch acknowledgements |
| 2026-09-22 | `CHANGELOG_647_model-names-native-defaults.md` | Refresh model names and delegate unconfigured session models to CLIs |
| 2026-09-22 | `CHANGELOG_646_provider-runtime-acp-refresh.md` | Refresh Claude, Codex, Grok runtimes and handle ACP advisory notices |
| 2026-09-20 | `CHANGELOG_645_shared-iab-login.md` | Share persistent IAB website login across sessions |
