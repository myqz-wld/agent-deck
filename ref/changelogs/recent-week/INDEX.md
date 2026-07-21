# Recent Week Changelogs

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
| 2026-07-16 | `CHANGELOG_378_plan-review-chat-feedback.md` | Align decision controls and show deep-review reply progress |
| 2026-07-16 | `CHANGELOG_377_worktree-lifecycle-contract.md` | Clarify default worktrees and require consent before branch deletion |
| 2026-07-15 | `CHANGELOG_376_plan-review-quote-and-decision-tray.md` | Refine deep-review quotes, decisions, and feedback confirmation |
| 2026-07-15 | `CHANGELOG_375_claude-codex-patch-releases.md` | Advance packaged Claude Agent SDK and Codex CLI patch releases |
| 2026-07-15 | `CHANGELOG_374_history-search-case-insensitive.md` | Make History search case-insensitive through an offline FTS rebuild |
| 2026-07-15 | `CHANGELOG_373_review-skill-lifecycle.md` | Separate simple and deep review lifecycles |
| 2026-07-15 | `CHANGELOG_372_asset-library-card-copy.md` | Align asset-library controls and Agent metadata |
| 2026-07-15 | `CHANGELOG_371_deepseek-summary-haiku-default.md` | Use Haiku as the blank Deepseek summary model |
| 2026-07-15 | `CHANGELOG_370_continuation-checkpoint-concurrency.md` | Bound concurrent continuation checkpoint refreshes |
| 2026-07-15 | `CHANGELOG_369_claude-codex-dependencies.md` | Refresh packaged Claude Agent SDK and Codex CLI dependencies |
| 2026-07-15 | `CHANGELOG_368_settings-panel-alignment.md` | Align settings copy, sandbox controls, and default reset |
| 2026-07-14 | `CHANGELOG_367_summary-refresh-thresholds.md` | Raise summary and checkpoint refresh thresholds |
| 2026-07-14 | `CHANGELOG_366_handoff-ownership-plan-review-hardening.md` | Preserve hand-off ownership and harden plan review |
| 2026-07-14 | `CHANGELOG_365_automatic-continuation-checkpoints.md` | Keep continuation checkpoints fresh and bounded |
| 2026-07-14 | `CHANGELOG_364_present-plan-deep-review.md` | Retain blocking plan gates and add isolated contextual review |
| 2026-07-14 | `CHANGELOG_363_runtime-controls-handoff-context.md` | Auto-save runtime controls and keep hand-off context current |
