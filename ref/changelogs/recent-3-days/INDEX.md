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
| 2026-07-14 | `CHANGELOG_366_handoff-ownership-plan-review-hardening.md` | Preserve hand-off ownership and harden plan review |
| 2026-07-14 | `CHANGELOG_365_automatic-continuation-checkpoints.md` | Keep continuation checkpoints fresh and bounded |
| 2026-07-14 | `CHANGELOG_364_present-plan-deep-review.md` | Retain blocking plan gates and add isolated contextual review |
| 2026-07-14 | `CHANGELOG_363_runtime-controls-handoff-context.md` | Auto-save runtime controls and keep hand-off context current |
| 2026-07-12 | `CHANGELOG_362_storage-maintenance-worker-provider-compaction.md` | Isolate live storage maintenance and restore Codex compact generation |
| 2026-07-11 | `CHANGELOG_361_storage-performance-observability-svg-icons.md` | Stage storage maintenance, require MCP readiness, and unify SVG icons |
| 2026-07-11 | `CHANGELOG_360_periodic-summary-evidence.md` | Make periodic summaries evidence-rich and revision-safe |
| 2026-07-11 | `CHANGELOG_359_session-pinning-reviewer-model.md` | Add persistent Live pins and update the Codex reviewer model |
| 2026-07-11 | `CHANGELOG_358_unified-continuation-context.md` | Unify provider-neutral Continuation Context across hand-off and recovery |
