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
| 2026-08-14 | `PLAN_38_feishu-one-click-server.md` | implementation complete; external live acceptance pending | Add server-managed Feishu for Relay and Full | CHANGELOG_612 / REVIEW_247 |
| 2026-08-12 | `PLAN_37_ipc-fast-read-readiness.md` | completed | Make fast IPC presentation complete and identity-safe | CHANGELOG_598 / REVIEW_238 |
| 2026-08-12 | `PLAN_36_remote-full-ui-parity.md` | delivery complete; installed acceptance pending | Complete source-authoritative Remote UI parity | CHANGELOG_592 / REVIEW_233 |
| 2026-08-11 | `PLAN_35_remote-transport-ui-convergence.md` | closed at user request | Fix Remote transport and UI; package without installed acceptance | CHANGELOG_591 / REVIEW_232 |
