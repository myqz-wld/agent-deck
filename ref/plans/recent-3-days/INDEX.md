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
| 2026-07-31 | `PLAN_29_review-208-defect-remediation.md` | completed | Close all fifteen defects confirmed by REVIEW_208 | CHANGELOG_427 / REVIEW_209 |
| 2026-07-31 | `PLAN_28_compatibility-and-defect-audit.md` | completed | Clean internal compatibility seams and audit functional defects | REVIEW_208 / PLAN_29 |
| 2026-07-31 | `PLAN_27_runtime-integration-repair.md` | completed with documented residuals | Repair reviewed Hook, gateway, and Codex provider integrations | CHANGELOG_425 / REVIEW_206 |
| 2026-07-30 | `PLAN_26_automatic-worktree-cwd-transition.md` | completed | Move session cwd automatically at the acknowledged provider boundary | CHANGELOG_418 / REVIEW_200 |
| 2026-07-30 | `PLAN_25_hook-event-lifecycle-completeness.md` | completed | Complete hook lifecycle capture without version or paging probes | CHANGELOG_415 |
| 2026-07-29 | `PLAN_24_maintenance-timeout-terminal-policy.md` | completed | Adopt safe disable-until-restart maintenance timeout policy | CHANGELOG_412 / REVIEW_188 |
| 2026-07-29 | `PLAN_23_whole-project-quality-refresh.md` | completed with documented residuals | Harden cross-adapter runtime, storage, UI, logging, and packaging | CHANGELOG_411 / REVIEW_187 |
