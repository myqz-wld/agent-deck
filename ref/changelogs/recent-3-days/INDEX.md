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
| 2026-10-01 | `CHANGELOG_674_collapsible-feishu-settings.md` | Remember assistant section collapse and simplify remote rate copy |
| 2026-10-01 | `CHANGELOG_673_remote-settings-autosave.md` | Autosave assistant choices and retain Remote read views |
| 2026-10-01 | `CHANGELOG_672_feishu-creation-defaults.md` | Prefill assistant creation defaults with editable remote Gateway choices |
| 2026-10-01 | `CHANGELOG_671_feishu-assistant-settings-flow.md` | Configure only the assistant and retain forms through fast reads |
| 2026-10-01 | `CHANGELOG_670_remote-only-feishu-settings.md` | Hide the Feishu settings group in local mode |
| 2026-09-30 | `CHANGELOG_669_feishu-markdown-replies.md` | Render formatted assistant replies as untitled rich text |
| 2026-09-30 | `CHANGELOG_668_unified-ask-user.md` | Route all three adapters' questions through MCP into Pending |
| 2026-09-30 | `CHANGELOG_667_feishu-assistant-voice.md` | Refine assistant warmth and update retained chats once |
| 2026-09-30 | `CHANGELOG_666_feishu-expired-approvals.md` | Explain expired approval cards and preserve terminal request states |
| 2026-09-30 | `CHANGELOG_665_independent-work-remote-connection.md` | Keep Remote reads connected and owner work independent |
| 2026-09-30 | `CHANGELOG_664_feishu-native-approval-depth.md` | Deliver structured native approvals within bounded payload limits |
| 2026-09-30 | `CHANGELOG_663_feishu-input-approval-progress.md` | Accept rich text, repair approval binding and show progress reactions |
| 2026-09-30 | `CHANGELOG_662_feishu-named-work-management.md` | Name work sessions and preserve assistant history and native controls |
| 2026-09-30 | `CHANGELOG_661_feishu-native-settings-approvals.md` | Remember native settings and complete readable approval cards |
| 2026-09-30 | `CHANGELOG_660_feishu-work-directory-expiry.md` | List work separately and ignore Feishu messages older than five minutes |
