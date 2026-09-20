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
| 2026-09-06 | `PLAN_51_worktree-user-message-projection.md` | completed | Preserve worktree input and simplify project documentation | REVIEW_271 |
| 2026-09-04 | `PLAN_50_model-routing-and-grok-defaults.md` | completed | Apply requested model defaults and table-only tier edits | CHANGELOG_640 |
| 2026-09-04 | `PLAN_49_astra-usage-and-model-inventory.md` | completed | Preserve quota groups and inventory model defaults | REVIEW_270 |
| 2026-09-04 | `PLAN_48_project-code-quality-remediation.md` | completed | Implement and validate all accepted scan findings | REVIEW_269 |
| 2026-09-04 | `PLAN_47_project-code-quality-scan.md` | completed | Concurrent project scan with verified findings | REVIEW_268 |
| 2026-09-04 | `PLAN_46_compatibility-dead-code-cleanup.md` | completed | Remove obsolete compatibility and production-dead code | CHANGELOG_638 / REVIEW_267 |
| 2026-08-27 | `PLAN_45_adapter-session-commands.md` | completed | Integrate native adapter slash commands into Agent Deck | CHANGELOG_631 |
| 2026-08-24 | `PLAN_44_pi-adapter-project-trust.md` | completed | Design Pi integration and add native project trust to existing adapters | CHANGELOG_628 / REVIEW_262 |
