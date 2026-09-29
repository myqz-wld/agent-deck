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
| 2026-09-29 | `REVIEW_297_feishu-long-connection-token.md` | Accept empty verification tokens in Feishu long connections | 1 HIGH fixed; live acceptance pending |
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
