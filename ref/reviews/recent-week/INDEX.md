# Recent Week Reviews

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
| 2026-10-03 | `REVIEW_314_file-operation-cards.md` | Unify file cards and repair Monaco teardown | 1 MEDIUM / 1 LOW fixed |
| 2026-10-02 | `REVIEW_313_grok-queued-mid-turn-interjections.md` | Resume queued Grok corrections during active turns | 1 MEDIUM fixed; 25 new regressions passed |
| 2026-10-02 | `REVIEW_312_claude-mid-turn-streaming-input.md` | Restore mid-turn streaming and correlated input acceptance | 1 MEDIUM fixed; regression suite passed |
| 2026-10-01 | `REVIEW_311_remote-ui-readiness.md` | Remote read retention, 150 ms presentation and autosave races | 4 findings repaired |
| 2026-09-30 | `REVIEW_310_feishu-markdown-replies.md` | Preserve message semantics while rendering native Markdown | 1 MEDIUM installed; real client display accepted |
| 2026-09-30 | `REVIEW_309_feishu-assistant-voice.md` | Refine assistant voice while preserving runtime controls | Installed; natural reply and retained history observed |
| 2026-09-30 | `REVIEW_308_feishu-expired-approvals.md` | Preserve expiry guidance without replaying approvals | 1 MEDIUM installed; native operation checks accepted |
| 2026-09-30 | `REVIEW_307_remote-worker-backpressure.md` | Preserve Worker writes and independent work hierarchy | 1 HIGH / 1 MEDIUM installed; live concurrent reads accepted |
| 2026-09-30 | `REVIEW_306_codex-failed-gateway-recovery.md` | Recover Gateway routing after terminal Codex errors | 1 HIGH / 1 MEDIUM / 1 LOW fixed; native acceptance passed |
| 2026-09-30 | `REVIEW_305_feishu-native-approval-depth.md` | Separate approval payload depth from response wrappers | 1 HIGH fixed; real owner approval and work reply accepted |
| 2026-09-30 | `REVIEW_304_feishu-input-approval-progress.md` | Validate rich input, approval races and correlated reactions | 1 HIGH / 3 MEDIUM installed; single formal app verified |
| 2026-09-30 | `REVIEW_303_feishu-named-work-management.md` | Name work and suppress late receipts with native management | Natural naming, manual rename and named reply accepted |
| 2026-09-30 | `REVIEW_302_feishu-native-settings-approvals.md` | Verify native settings and complete Feishu approval cards | 1 HIGH / 4 MEDIUM installed; cards and replies accepted |
| 2026-09-30 | `REVIEW_301_feishu-work-directory-expiry.md` | Separate work discovery and discard expired Feishu input | 2 MEDIUM installed; owner query acceptance pending |
| 2026-09-30 | `REVIEW_300_core-read-tool-annotations.md` | Restore read-only Core MCP discovery and approval semantics | 1 HIGH fixed, installed and live accepted |
