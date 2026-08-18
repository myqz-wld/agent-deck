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
| 2026-08-18 | `PLAN_43_unified-browser-skill-cli-iab.md` | completed with Remote live gate retained | Unify Browser skill, CLI, responsive IAB, and annotation | CHANGELOG_618 / REVIEW_255 |
| 2026-08-18 | `PLAN_42_summary-settings-layout-and-timeout-policy.md` | completed | Align generator settings order and internalize summary timeout | REVIEW_254 |
| 2026-08-18 | `PLAN_41_current-only-gap-sweep.md` | completed | Close remaining utility, root-config, prompt, and settings-copy gaps | REVIEW_253 |
| 2026-08-17 | `PLAN_40_current-only-compatibility-sweep.md` | completed | Remove unsupported compatibility code by functional boundary | REVIEW_252 |
| 2026-08-17 | `PLAN_39_codex-gateway-toml-cutover.md` | completed | Cut Codex selection over to complete Gateway TOML files | CHANGELOG_616 |
