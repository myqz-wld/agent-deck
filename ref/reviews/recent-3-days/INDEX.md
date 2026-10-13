# Recent 3 Days Reviews

## Scope

This bucket contains only reviews that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `reviewed_at` is within the last 3 days, inclusive |
| `recent-week` | `reviewed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `reviewed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `reviewed_at` is older than 30 days, or missing a parseable date |

## Index Table

| reviewed_at | File | Topic | Severity Distribution |
|---|---|---|---|
| 2026-10-13 | `REVIEW_320_claude-consecutive-message-interruption.md` | Classify streamed Claude corrections as interruptions and retain busy state | 2 MEDIUM fixed; full regression suite passed |
| 2026-10-12 | `REVIEW_319_feishu-closed-assistant-recovery.md` | Restore deferred Codex assistant recovery before MCP initialization | 1 HIGH / 1 MEDIUM fixed; activation pending |
| 2026-10-12 | `REVIEW_318_macos-installer-managed-services.md` | Pause managed KeepAlive services during local app installation | 1 HIGH / 2 MEDIUM fixed; native and full regression checks passed |
| 2026-10-11 | `REVIEW_317_browser-idle-resume.md` | Restore Browser context after idle closure without blocking Codex | 1 HIGH / 1 MEDIUM fixed; regression and native checks passed |
