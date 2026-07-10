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
| 2026-07-10 | `CHANGELOG_354_thinking-options-and-claude-usage.md` | Refine thinking options and collect Claude reasoning usage |
| 2026-07-09 | `CHANGELOG_353_spawn-session-native-fork.md` | Add provider-native parallel session forks |
| 2026-07-09 | `CHANGELOG_352_remove-fable-5-suggestion.md` | Remove redundant fable-5 suggestion |
| 2026-07-09 | `CHANGELOG_351_mcp-prompt-contracts.md` | Make MCP contracts explicit and self-correcting |
| 2026-07-09 | `CHANGELOG_350_codex-collaboration-observability.md` | Complete Codex collaboration activity |
| 2026-07-09 | `CHANGELOG_349_project-engineering-foundation.md` | Align repository engineering foundation |
