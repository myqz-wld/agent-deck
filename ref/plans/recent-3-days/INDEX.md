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
| 2026-08-03 | `PLAN_30_context-window-observation-unification.md` | completed | Unify observed context capacity across continuations | CHANGELOG_430 / REVIEW_212 |
| 2026-07-31 | `PLAN_29_review-208-defect-remediation.md` | completed | Close all fifteen defects confirmed by REVIEW_208 | CHANGELOG_427 / REVIEW_209 |
| 2026-07-31 | `PLAN_28_compatibility-and-defect-audit.md` | completed | Clean internal compatibility seams and audit functional defects | REVIEW_208 / PLAN_29 |
| 2026-07-31 | `PLAN_27_runtime-integration-repair.md` | completed with documented residuals | Repair reviewed Hook, gateway, and Codex provider integrations | CHANGELOG_425 / REVIEW_206 |
