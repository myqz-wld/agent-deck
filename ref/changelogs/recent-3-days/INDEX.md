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
| 2026-09-05 | `CHANGELOG_642_codex-runtime-release-sync.md` | Upgrade embedded Codex to 0.153.4 and prepare the macOS app |
| 2026-09-04 | `CHANGELOG_641_codex-quota-visibility.md` | Hide Codex reserve and Spark quota windows in the Data panel |
| 2026-09-04 | `CHANGELOG_640_model-routing-and-grok-defaults.md` | Refresh model suggestions, Grok defaults and Skill model tiers |
| 2026-09-04 | `CHANGELOG_639_adapter-settings-copy.md` | Align adapter settings descriptions and names |
| 2026-09-04 | `CHANGELOG_638_compatibility-dead-code-retirement.md` | Retire obsolete compatibility and production-dead code |
| 2026-09-04 | `CHANGELOG_637_application-convention-boundaries.md` | Keep conventions task-focused and require host-process approval |
| 2026-09-04 | `CHANGELOG_636_bundled-only-assets-library.md` | Show only bundled Skills and Agents in the Assets Library |
| 2026-09-03 | `CHANGELOG_635_provider-runtime-browser-remount.md` | Refresh provider/app dependencies and remount Browser contexts |
