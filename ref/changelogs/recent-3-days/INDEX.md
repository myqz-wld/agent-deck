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
| 2026-07-29 | `CHANGELOG_411_whole-project-quality-refresh.md` | Harden runtime, storage, UI, logging, dependencies, and packaging |
| 2026-07-28 | `CHANGELOG_410_codex-live-approval-review-runtime.md` | Expose live Codex approvals and make review runtime prompt-owned |
| 2026-07-27 | `CHANGELOG_409_session-runtime-defaults-ui.md` | Default Codex approvals and align session runtime inheritance |
| 2026-07-27 | `CHANGELOG_408_concrete-session-creation-defaults.md` | Resolve and show concrete defaults in compact new-session controls |
| 2026-07-27 | `CHANGELOG_407_codex-session-approval-policy.md` | Choose Codex approval policy when creating human sessions |
| 2026-07-27 | `CHANGELOG_406_grok-native-sandbox-controls.md` | Control Grok Build's native sandbox across every session path |
| 2026-07-27 | `CHANGELOG_405_transparent-usage-refresh-latency.md` | Clear transparent artifacts and bound provider refresh latency |
| 2026-07-27 | `CHANGELOG_404_token-usage-presence-repair.md` | Restore daily token totals without weakening strict provider totals |
| 2026-07-27 | `CHANGELOG_403_browser-waits-open-dom-retention.md` | Add browser waits, open-DOM refs, and seven-day screenshot retention |
| 2026-07-27 | `CHANGELOG_402_provider-usage-runtime-control-fidelity.md` | Preserve provider usage and adapter-owned runtime controls |
| 2026-07-27 | `CHANGELOG_401_concurrent-batch-review.md` | Preserve adversarial review across concurrent scope batches |
| 2026-07-27 | `CHANGELOG_400_cross-adapter-browser-engine.md` | Open the in-app browser to every adapter through MCP browser tools |
| 2026-07-27 | `CHANGELOG_399_data-token-summary-alignment.md` | Align the daily token summary with neighboring Data sections |
