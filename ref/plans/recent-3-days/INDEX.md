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
| 2026-08-12 | `PLAN_37_ipc-fast-read-readiness.md` | completed | Make fast IPC presentation complete and identity-safe | CHANGELOG_598 / REVIEW_238 |
| 2026-08-12 | `PLAN_36_remote-full-ui-parity.md` | delivery complete; installed acceptance pending | Complete source-authoritative Remote UI parity | CHANGELOG_592 / REVIEW_233 |
| 2026-08-11 | `PLAN_35_remote-transport-ui-convergence.md` | closed at user request | Fix Remote transport and UI; package without installed acceptance | CHANGELOG_591 / REVIEW_232 |
| 2026-08-10 | `PLAN_34_linux-deployment-automation.md` | completed | Add managed Relay, Worker, and Full deployment automation | CHANGELOG_584 / REVIEW_222 |
| 2026-08-09 | `PLAN_33_relay-quadlet-live-acceptance.md` | completed | Migrate AWS Relay to rootless Podman with an isolated Mac Worker | CHANGELOG_580-582 / REVIEW_219-221 |
| 2026-08-09 | `PLAN_32_remote-local-capability-parity.md` | completed with external acceptance | Complete Local/Remote parity and Workspace-sandbox delivery | CHANGELOG_578 / REVIEW_217 |
