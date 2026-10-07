# Recent Month Plans

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
| 2026-09-29 | `PLAN_68_feishu-assistant-activation.md` | completed | Verify installed assistant/work-session release and clean artifacts | `CHANGELOG_659_feishu-assistant-contexts.md` |
| 2026-09-29 | `PLAN_67_codex-resets-dialogs.md` | completed | Compact quota resets and unified confirmation dialogs | `CHANGELOG_658_codex-resets-dialogs.md` |
| 2026-09-29 | `PLAN_66_feishu-model-selection-activation.md` | completed | Activate model selections and remove duplicate app copies | `CHANGELOG_657_feishu-conversation-model-selections.md` |
| 2026-09-29 | `PLAN_65_session-output-gateway-thinking.md` | completed | Readable output and isolated Gateway thinking defaults | `CHANGELOG_655_session-output-gateway-thinking.md` |
| 2026-09-29 | `PLAN_64_feishu-desktop-activation.md` | completed | Install Browser/menu repairs and verify managed runtime health | `REVIEW_290_browser-styled-controls-monaco.md` |
| 2026-09-29 | `PLAN_63_grok-credential-installed-acceptance.md` | completed | Install fixes and accept Worker/Relay health | `REVIEW_287_grok-credential-projection-refresh.md` |
| 2026-09-29 | `PLAN_62_inline-file-diffs.md` | completed | Inline file changes and shared provider diff views | `CHANGELOG_654_inline-file-diffs.md` |
| 2026-09-29 | `PLAN_61_ui-icons-lightbox-controls.md` | completed | Unify UI icons and refine image-preview controls | `CHANGELOG_653_ui-icons-lightbox-controls.md` |
| 2026-09-29 | `PLAN_60_session-content-generated-images.md` | completed | Improve session content and generated-image display | `CHANGELOG_652_session-content-generated-images.md` |
| 2026-09-29 | `PLAN_59_relay-handshake-investigation.md` | completed | Verify both Relay endpoints after Worker installation | `REVIEW_282_relay-stream-retirement-isolation.md` |
| 2026-09-28 | `PLAN_58_relay-runtime-recovery.md` | completed | Restore Relay, Worker, and supervisor | `REVIEW_281_relay-runtime-directory-recovery.md` |
| 2026-09-28 | `PLAN_57_codex-live-gateway-switch.md` | completed | Apply Codex Gateway changes before the next turn | `REVIEW_279_codex-live-gateway-switch.md` |
| 2026-09-23 | `PLAN_56_enter-worktree-preparation-timeout.md` | completed | Bound enter preparation and preserve late-result safety | REVIEW_277 |
| 2026-09-22 | `PLAN_55_grok-native-model-selection.md` | completed | Delegate Grok selection and discovery to the CLI | CHANGELOG_648 |
| 2026-09-19 | `PLAN_54_gateway-model-presentation.md` | completed | Preserve live models and stabilize Gateway default reads | REVIEW_275 |
| 2026-09-16 | `PLAN_53_privacy-and-compatibility-cleanup.md` | completed | Scrub private history and retire obsolete compatibility | REVIEW_274 |
| 2026-09-16 | `PLAN_52_relay-worker-live-acceptance.md` | completed with installed acceptance pending | Verify Relay and repair packaged Worker startup | REVIEW_273 |
