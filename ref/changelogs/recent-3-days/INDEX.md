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
| 2026-07-31 | `CHANGELOG_427_compatibility-and-defect-remediation.md` | Clean compatibility seams and close all REVIEW_208 defects |
| 2026-07-31 | `CHANGELOG_426_exit-worktree-output-schema-compatibility.md` | Publish a callable exit_worktree result schema |
| 2026-07-31 | `CHANGELOG_425_codex-provider-hook-runtime-hardening.md` | Restore Codex providers and harden Hook/runtime boundaries |
| 2026-07-31 | `CHANGELOG_424_plan-review-expandable-inputs.md` | Replace deep-review field resizing with expand actions |
| 2026-07-31 | `CHANGELOG_423_adapter_native_gateway_profile_selectors.md` | Use Claude Gateway and native Codex profile selectors |
| 2026-07-31 | `CHANGELOG_422_retired_codex_user_config_ownership.md` | Stop owning or cleaning native Codex user configuration |
| 2026-07-31 | `CHANGELOG_421_spawn-session-model-suggestions.md` | Remove stale GPT and Deepseek spawn model suggestions |
| 2026-07-31 | `CHANGELOG_420_archive-plan-dead-code-removal.md` | Remove retired archive plan MCP code and orphaned cleanup paths |
| 2026-07-30 | `CHANGELOG_419_branch-independent-worktree-lifecycle.md` | Isolate worktree lifecycle from branches and refs |
| 2026-07-30 | `CHANGELOG_418_automatic-worktree-cwd-transition.md` | Move sessions across worktrees at an automatic safe turn boundary |
| 2026-07-30 | `CHANGELOG_417_session-list-runtime-metadata.md` | Show branch and context occupancy on live session cards |
| 2026-07-30 | `CHANGELOG_416_handoff-context-usage.md` | Fix hand-off fields and show live context occupancy |
| 2026-07-30 | `CHANGELOG_415_hook-event-lifecycle-completeness.md` | Capture lifecycle hooks and close incomplete Codex tool activity |
| 2026-07-29 | `CHANGELOG_414_post-acceptance-delivery-durability.md` | Prevent uncertain message redelivery after adapter acceptance |
| 2026-07-29 | `CHANGELOG_413_session-ui-scope-alignment.md` | Restore scoped expand controls and align session runtime labels |
| 2026-07-29 | `CHANGELOG_412_maintenance-timeout-terminal-policy.md` | Disable storage maintenance until restart after a worker timeout |
| 2026-07-29 | `CHANGELOG_411_whole-project-quality-refresh.md` | Harden runtime, storage, UI, logging, dependencies, and packaging |
| 2026-07-28 | `CHANGELOG_410_codex-live-approval-review-runtime.md` | Expose live Codex approvals and make review runtime prompt-owned |
