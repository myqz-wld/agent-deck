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
| 2026-09-22 | `PLAN_55_grok-native-model-selection.md` | completed | Delegate Grok selection and discovery to the CLI | CHANGELOG_648 |
| 2026-09-19 | `PLAN_54_gateway-model-presentation.md` | completed | Preserve live models and stabilize Gateway default reads | REVIEW_275 |
| 2026-09-16 | `PLAN_53_privacy-and-compatibility-cleanup.md` | completed | Scrub private history and retire obsolete compatibility | REVIEW_274 |
| 2026-09-16 | `PLAN_52_relay-worker-live-acceptance.md` | completed with installed acceptance pending | Verify Relay and repair packaged Worker startup | REVIEW_273 |
| 2026-09-06 | `PLAN_51_worktree-user-message-projection.md` | completed | Preserve worktree input and simplify project documentation | REVIEW_271 |
| 2026-09-04 | `PLAN_50_model-routing-and-grok-defaults.md` | completed | Apply requested model defaults and table-only tier edits | CHANGELOG_640 |
| 2026-09-04 | `PLAN_49_astra-usage-and-model-inventory.md` | completed | Preserve quota groups and inventory model defaults | REVIEW_270 |
| 2026-09-04 | `PLAN_48_project-code-quality-remediation.md` | completed | Implement and validate all accepted scan findings | REVIEW_269 |
| 2026-09-04 | `PLAN_47_project-code-quality-scan.md` | completed | Concurrent project scan with verified findings | REVIEW_268 |
| 2026-09-04 | `PLAN_46_compatibility-dead-code-cleanup.md` | completed | Remove obsolete compatibility and production-dead code | CHANGELOG_638 / REVIEW_267 |
