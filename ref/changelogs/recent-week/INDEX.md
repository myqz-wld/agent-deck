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
| 2026-08-20 | `CHANGELOG_622_global-stable-action-presentation.md` | Stabilize dynamic actions and 150 ms configuration visuals globally |
| 2026-08-20 | `CHANGELOG_621_stable-session-create-action.md` | Keep the create action visually and geometrically stable |
| 2026-08-20 | `CHANGELOG_620_atomic-session-configuration-readiness.md` | Keep adapter configuration switches visually atomic for 150 ms |
| 2026-08-19 | `CHANGELOG_619_provider-runtime-release-sync.md` | Sync embedded provider runtimes and local CLIs to stable releases |
| 2026-08-18 | `CHANGELOG_618_unified-browser-skill-cli-iab.md` | Unify Browser skill, CLI, responsive IAB, and annotation |
| 2026-08-17 | `CHANGELOG_617_next-turn-gateway-switching.md` | Apply choice-only Gateway changes from the next Codex turn |
| 2026-08-17 | `CHANGELOG_616_codex-gateway-toml-cutover.md` | Cut Codex selection over to complete Gateway TOML files |
