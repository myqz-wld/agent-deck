# Recent 3 Days Plans

## Scope

This bucket contains only plans that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `Completed At` or `completed_at` is within the last 3 days, inclusive |
| `recent-week` | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date |

## Index Table

| Completed At | Plan | Status | Summary | Related Final Record |
|---|---|---|---|---|
| 2026-08-17 | `PLAN_39_codex-gateway-toml-cutover.md` | completed | Cut Codex selection over to complete Gateway TOML files | CHANGELOG_616 |
| 2026-08-14 | `PLAN_38_feishu-one-click-server.md` | Relay accepted; Full/real Feishu external pending | Add server-managed Feishu for Relay and Full | CHANGELOG_612 / REVIEW_248 / REVIEW_249 |
