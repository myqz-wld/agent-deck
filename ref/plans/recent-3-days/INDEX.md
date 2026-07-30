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
| 2026-07-30 | `PLAN_25_hook-event-lifecycle-completeness.md` | completed | Complete hook lifecycle capture without version or paging probes | CHANGELOG_415 |
| 2026-07-29 | `PLAN_24_maintenance-timeout-terminal-policy.md` | completed | Adopt safe disable-until-restart maintenance timeout policy | CHANGELOG_412 / REVIEW_188 |
| 2026-07-29 | `PLAN_23_whole-project-quality-refresh.md` | completed with documented residuals | Harden cross-adapter runtime, storage, UI, logging, and packaging | CHANGELOG_411 / REVIEW_187 |
| 2026-07-27 | `PLAN_22_grok-native-sandbox-controls.md` | completed | Control Grok Build's native process sandbox across session paths | CHANGELOG_406 |
| 2026-07-27 | `PLAN_21_browser-p0-p1-hardening.md` | completed | Harden browser readiness, DOM coverage, and screenshot retention | CHANGELOG_403 / REVIEW_182 |
| 2026-07-27 | `PLAN_20_provider-usage-runtime-control-fidelity.md` | completed | Preserve provider usage and adapter-owned runtime controls | CHANGELOG_402 |
| 2026-07-27 | `PLAN_19_cross-adapter-browser-engine.md` | implemented, real-session validation pending | Open and harden the cross-adapter in-app browser | CHANGELOG_400 / CHANGELOG_403 |
