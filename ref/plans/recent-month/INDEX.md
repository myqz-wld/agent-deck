# Recent Month Plans

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
| 2026-06-26 | `session-trajectory-mcp-tool-20260626.md` | completed | Session Trajectory MCP Tool | CHANGELOG_328 |
| 2026-06-17 | `spawn-teamless-reply-anchor-20260617.md` | completed | Spawn Teamless Reply Anchor | CHANGELOG_279 / REVIEW_119 |
