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
| 2026-08-05 | `CHANGELOG_434_adapter-runtime-event-fidelity.md` | Refresh runtimes and restore native-agent/tool visibility |
| 2026-08-04 | `CHANGELOG_433_review-responsibility-and-depth.md` | Unify review roles and keep follow-up severity-driven |
| 2026-08-04 | `CHANGELOG_432_diff-history-and-runtime-diagnostics.md` | Keep diffs current and make runtime delays diagnosable |
| 2026-08-03 | `CHANGELOG_431_concise-session-empty-state.md` | Simplify the session-list empty-state guidance |
| 2026-08-03 | `CHANGELOG_430_context-window-observation-unification.md` | Unify observed context capacity across continuations |
| 2026-08-03 | `CHANGELOG_429_hook-ownership-and-provider-dependencies.md` | Keep hooks idempotent and refresh provider dependencies |
| 2026-08-03 | `CHANGELOG_428_provider-token-accounting-and-rate-repair.md` | Repair provider token totals and tok/s calibration |
