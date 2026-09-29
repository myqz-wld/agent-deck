# Recent 3 Days Plans

## Scope

This bucket contains only plans that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `Completed At` or `completed_at` is within the last 3 days, inclusive |
| `recent-week` | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date |

## Index Table

| Completed At | Plan | Status | Summary | Related Final Record |
|---|---|---|---|---|
| 2026-09-29 | `PLAN_63_grok-credential-installed-acceptance.md` | completed | Install fixes and accept Worker/Relay health | `REVIEW_287_grok-credential-projection-refresh.md` |
| 2026-09-29 | `PLAN_62_inline-file-diffs.md` | completed | Inline file changes and shared provider diff views | `CHANGELOG_654_inline-file-diffs.md` |
| 2026-09-29 | `PLAN_61_ui-icons-lightbox-controls.md` | completed | Unify UI icons and refine image-preview controls | `CHANGELOG_653_ui-icons-lightbox-controls.md` |
| 2026-09-29 | `PLAN_60_session-content-generated-images.md` | completed | Improve session content and generated-image display | `CHANGELOG_652_session-content-generated-images.md` |
| 2026-09-29 | `PLAN_59_relay-handshake-investigation.md` | completed | Verify both Relay endpoints after Worker installation | `REVIEW_282_relay-stream-retirement-isolation.md` |
| 2026-09-28 | `PLAN_58_relay-runtime-recovery.md` | completed | Restore Relay, Worker, and supervisor | `REVIEW_281_relay-runtime-directory-recovery.md` |
| 2026-09-28 | `PLAN_57_codex-live-gateway-switch.md` | completed | Apply Codex Gateway changes before the next turn | `REVIEW_279_codex-live-gateway-switch.md` |
