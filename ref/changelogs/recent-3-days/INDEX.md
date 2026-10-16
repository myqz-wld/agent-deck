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
| 2026-10-16 | `CHANGELOG_688_overlay-translucency.md` | Preserve colors and add light translucency to dialogs and expanded panels |
| 2026-10-15 | `CHANGELOG_687_native-work-conversation.md` | Reuse child conversation rows and keep commands in Activity Bash rows |
| 2026-10-15 | `CHANGELOG_686_native-work-strip.md` | Add native task strip, retained child history and exact task controls |
| 2026-10-15 | `CHANGELOG_685_tool-search-fallbacks.md` | Apply Codex startup catalogs and verify Claude Tool Search opt-in |
| 2026-10-15 | `CHANGELOG_684_runtime-component-injection.md` | Pin component versions and add explicit native session refresh |
| 2026-10-15 | `CHANGELOG_683_claude-immediate-teammate-messages.md` | Deliver Claude teammate messages during active turns; verify Grok parity |
| 2026-10-14 | `CHANGELOG_682_borderless-activity-rows.md` | Restore light borderless text for ordinary activity events |
| 2026-10-14 | `CHANGELOG_681_unified-compaction-status.md` | Unify compaction, commands, and activity; preserve system bubbles |
| 2026-10-14 | `CHANGELOG_680_provider-runtime-readme-refresh.md` | Refresh bundled Claude and Grok; simplify the project README |
| 2026-10-14 | `CHANGELOG_679_runtime-confirmation-parity.md` | Align permission and sandbox confirmations across providers and surfaces |
| 2026-10-14 | `CHANGELOG_678_runtime-log-observability.md` | Bound Worker logs and add private runtime/heartbeat diagnostics |
| 2026-10-14 | `CHANGELOG_677_unified-permission-modes.md` | Unify native approval presets across Claude, Codex, and Grok |
| 2026-10-14 | `CHANGELOG_676_mcp-discovery-and-diff-focus.md` | Discover independent sessions, gate shutdown, and reveal the first diff |
