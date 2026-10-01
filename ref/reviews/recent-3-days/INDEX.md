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
| 2026-09-29 | `REVIEW_299_feishu-assistant-contexts.md` | Stabilize session IDs and isolate assistant history | 3 HIGH / 1 MEDIUM fixed; live acceptance pending |
| 2026-09-29 | `REVIEW_298_dialogs-quota-reset-safety.md` | Inspect all dialogs and quota-reset boundaries | 2 MEDIUM fixed; full suite and Browser checked |
| 2026-09-29 | `REVIEW_297_feishu-event-metadata.md` | Repair Feishu delivery, terminal transports and storage growth | 6 HIGH fixed and active; final chat tests pending |
| 2026-09-29 | `REVIEW_296_session-output-gateway-thinking.md` | Correct result presentation and Gateway thinking defaults | 3 MEDIUM / 2 LOW fixed; source and Browser verified |
| 2026-09-29 | `REVIEW_295_feishu-bootstrap-runtime-recovery.md` | Activate current runtime and recover empty Feishu bootstrap | 1 HIGH / 1 MEDIUM fixed; connection verified |
| 2026-09-29 | `REVIEW_294_claude-permission-indicators.md` | Simplify Claude option annotations and warning markers | 1 LOW fixed; installed bundle verified |
| 2026-09-29 | `REVIEW_293_running-relay-recovery.md` | Recover running Relay without startup socket probes | 1 MEDIUM fixed; server activation verified |
| 2026-09-29 | `REVIEW_292_feishu-rollback-credential-history.md` | Preserve revoked history and recover interrupted Relay updates | 1 HIGH / 1 MEDIUM fixed; server verified |
| 2026-09-29 | `REVIEW_291_feishu-startup-prerequisites.md` | Correct HTTPS preflight and wait for Feishu readiness | 2 MEDIUM fixed; server activation verified |
| 2026-09-29 | `REVIEW_290_browser-styled-controls-monaco.md` | Expose styled controls and update real Monaco content | 2 MEDIUM fixed; installed Browser verified |
| 2026-09-29 | `REVIEW_289_inline-diff-readiness.md` | Tighten diff spacing and share loading grace | 1 MEDIUM / 1 LOW fixed and installed |
| 2026-09-29 | `REVIEW_288_hosted-app-replacement.md` | Preserve packages and quiesce managed jobs before replacement | 2 MEDIUM fixed; installation accepted |
| 2026-09-29 | `REVIEW_287_grok-credential-projection-refresh.md` | Refresh Grok credentials and restore the headless gate | 2 MEDIUM / 2 LOW fixed; issue resolved |
| 2026-09-29 | `REVIEW_286_inline-file-diffs.md` | Verify file-change retrieval and provider diff consistency | 4 MEDIUM / 1 LOW fixed |
| 2026-09-29 | `REVIEW_285_ui-icons-lightbox-controls.md` | Verify UI icons and image-preview interaction | 1 MEDIUM / 3 LOW fixed |
| 2026-09-29 | `REVIEW_284_session-content-image-chain.md` | Verify provider content and image ownership chain | In-scope findings resolved in source |
| 2026-09-29 | `REVIEW_282_relay-stream-retirement-isolation.md` | Verify Relay stream retirement isolation | 1 HIGH fixed; credential acceptance in REVIEW_287 |
| 2026-09-28 | `REVIEW_283_session-content-presentation.md` | Inspect provider content gaps and validate math rendering | Resolved in REVIEW_284 |
| 2026-09-28 | `REVIEW_281_relay-runtime-directory-recovery.md` | Recover Relay runtime directories and service startup | 1 HIGH fixed |
| 2026-09-28 | `REVIEW_280_macos-installer-process-identity.md` | Bound installer shutdown to verified app processes | 1 HIGH fixed |
| 2026-09-28 | `REVIEW_279_codex-live-gateway-switch.md` | Apply Gateway changes to loaded Codex sessions | 1 HIGH fixed |
| 2026-09-28 | `REVIEW_278_browser-svg-ref-click.md` | Activate SVG Browser snapshot refs | 1 MEDIUM fixed |
