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
| 2026-08-17 | `CHANGELOG_616_codex-gateway-toml-cutover.md` | Cut Codex selection over to complete Gateway TOML files |
| 2026-08-16 | `CHANGELOG_615_codex-gateway-capacity-profiles.md` | Add per-provider Codex context and compaction profiles |
| 2026-08-16 | `CHANGELOG_614_provider-runtime-app-refresh.md` | Refresh Claude and Grok runtimes and reinstall the macOS app |
| 2026-08-15 | `CHANGELOG_613_interruptible-reconnect-and-session-readiness.md` | Make Remote reconnect interruptible and finish 150 ms session readiness |
| 2026-08-14 | `CHANGELOG_612_feishu-server-one-click.md` | Add server-managed Feishu lifecycle for Relay and Full |
