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
| 2026-09-30 | `CHANGELOG_661_feishu-native-settings-approvals.md` | Remember native settings and complete readable approval cards |
| 2026-09-30 | `CHANGELOG_660_feishu-work-directory-expiry.md` | List work separately and ignore Feishu messages older than five minutes |
| 2026-09-29 | `CHANGELOG_659_feishu-assistant-contexts.md` | Separate assistant chat, work targets and reply presentation |
| 2026-09-29 | `CHANGELOG_658_codex-resets-dialogs.md` | Add confirmed Codex resets and consistent application dialogs |
| 2026-09-29 | `CHANGELOG_657_feishu-conversation-model-selections.md` | Share remembered Feishu models and start conversational sessions |
| 2026-09-29 | `CHANGELOG_656_provider-runtimes-model-suggestions.md` | Upgrade bundled provider runtimes and refresh Codex model suggestions |
| 2026-09-29 | `CHANGELOG_655_session-output-gateway-thinking.md` | Readable tool results and Gateway-specific thinking defaults |
| 2026-09-29 | `CHANGELOG_654_inline-file-diffs.md` | Open recorded file changes inline and align provider diff views |
| 2026-09-29 | `CHANGELOG_653_ui-icons-lightbox-controls.md` | Unify UI icons and fade image-preview controls while idle |
| 2026-09-29 | `CHANGELOG_652_session-content-generated-images.md` | Improve provider cards and add generated-image preview and saving |
| 2026-09-28 | `CHANGELOG_651_markdown-math-rendering.md` | Render chat math with local fonts, safe delimiters, and bounded layout |
| 2026-09-28 | `CHANGELOG_650_macos-installer-process-identity.md` | Require explicit app shutdown and verify exact macOS process identities |
| 2026-09-28 | `CHANGELOG_649_provider-runtime-stable-refresh.md` | Refresh stable Claude, Codex, protocol SDKs, and macOS bundled runtimes |
