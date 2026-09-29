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
| 2026-09-28 | `REVIEW_280_macos-installer-process-identity.md` | Bound installer shutdown to verified app processes | 1 HIGH fixed |
| 2026-09-28 | `REVIEW_279_codex-live-gateway-switch.md` | Apply Gateway changes to loaded Codex sessions | 1 HIGH fixed |
| 2026-09-28 | `REVIEW_278_browser-svg-ref-click.md` | Activate SVG Browser snapshot refs | 1 MEDIUM fixed |
