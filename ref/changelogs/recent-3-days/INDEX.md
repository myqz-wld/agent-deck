# Recent 3 Days Changelogs

## Scope

This bucket contains only changelogs that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `changed_at` is within the last 3 days, inclusive |
| `recent-week` | `changed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `changed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `changed_at` is older than 30 days, or missing a parseable date |

## Index Table

| changed_at | File | Summary (<= 80 chars) |
|---|---|---|
| 2026-08-03 | `CHANGELOG_431_concise-session-empty-state.md` | Simplify the session-list empty-state guidance |
| 2026-08-03 | `CHANGELOG_430_context-window-observation-unification.md` | Unify observed context capacity across continuations |
| 2026-08-03 | `CHANGELOG_429_hook-ownership-and-provider-dependencies.md` | Keep hooks idempotent and refresh provider dependencies |
| 2026-08-03 | `CHANGELOG_428_provider-token-accounting-and-rate-repair.md` | Repair provider token totals and tok/s calibration |
| 2026-07-31 | `CHANGELOG_427_compatibility-and-defect-remediation.md` | Clean compatibility seams and close all REVIEW_208 defects |
| 2026-07-31 | `CHANGELOG_426_exit-worktree-output-schema-compatibility.md` | Publish a callable exit_worktree result schema |
| 2026-07-31 | `CHANGELOG_425_codex-provider-hook-runtime-hardening.md` | Restore Codex providers and harden Hook/runtime boundaries |
| 2026-07-31 | `CHANGELOG_424_plan-review-expandable-inputs.md` | Replace deep-review field resizing with expand actions |
| 2026-07-31 | `CHANGELOG_423_adapter_native_gateway_profile_selectors.md` | Use Claude Gateway and native Codex profile selectors |
| 2026-07-31 | `CHANGELOG_422_retired_codex_user_config_ownership.md` | Stop owning or cleaning native Codex user configuration |
| 2026-07-31 | `CHANGELOG_421_spawn-session-model-suggestions.md` | Remove stale GPT and Deepseek spawn model suggestions |
| 2026-07-31 | `CHANGELOG_420_archive-plan-dead-code-removal.md` | Remove retired archive plan MCP code and orphaned cleanup paths |
