# Recent Week Plans

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
| 2026-08-10 | `PLAN_34_linux-deployment-automation.md` | completed | Add managed Relay, Worker, and Full deployment automation | CHANGELOG_584 / REVIEW_222 |
| 2026-08-09 | `PLAN_33_relay-quadlet-live-acceptance.md` | completed | Migrate AWS Relay to rootless Podman with an isolated Mac Worker | CHANGELOG_580-582 / REVIEW_219-221 |
| 2026-08-09 | `PLAN_32_remote-local-capability-parity.md` | completed with external acceptance | Complete Local/Remote parity and Workspace-sandbox delivery | CHANGELOG_578 / REVIEW_217 |
| 2026-08-08 | `PLAN_31_handoff-lifecycle-context-v2.md` | completed with documented residuals | Harden handoff context, lifecycle, and rollback boundaries | CHANGELOG_436 / REVIEW_216 |
