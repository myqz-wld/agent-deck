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
| 2026-08-15 | `REVIEW_251_remote-profile-schema-migration.md` | Remote profile startup migration | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-08-15 | `REVIEW_250_interruptible-reconnect-and-session-readiness.md` | Interruptible reconnect and session readiness | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-08-14 | `REVIEW_249_feishu-relay-live-acceptance.md` | Feishu Relay deployment and Server CLI live acceptance | 0 CRITICAL / 3 HIGH fixed / 2 MEDIUM fixed |
| 2026-08-14 | `REVIEW_248_feishu-server-one-click-acceptance.md` | Feishu server connection and sidecar lifecycle | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed / 2 LOW fixed |
| 2026-08-13 | `REVIEW_247_feishu-p0-surface-cleanup.md` | Dormant product surface removal | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-08-13 | `REVIEW_246_grok-active-plugin-assets.md` | Grok active Plugin asset discovery | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-08-13 | `REVIEW_245_remote-asset-relay-flow-control.md` | Remote asset Relay flow control and diagnostics | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed / 2 LOW fixed |
| 2026-08-13 | `REVIEW_244_explicit-ssh-reconnect.md` | Explicit SSH reconnect lifecycle | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed |
| 2026-08-13 | `REVIEW_243_remote-settings-local-controls.md` | Remote settings ownership and layout | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-08-13 | `REVIEW_242_simplified-session-and-team-navigation.md` | Session and navigation simplification | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed |
| 2026-08-13 | `REVIEW_241_remote-ui-runtime-convergence.md` | Remote UI and runtime convergence | 0 CRITICAL / 3 HIGH fixed / 4 MEDIUM fixed / 2 LOW fixed |
| 2026-08-13 | `REVIEW_240_macos-worker-launchagent-replacement.md` | macOS Worker LaunchAgent replacement | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-13 | `REVIEW_239_codex-cache-write-usage-wiring.md` | Codex cache-write usage wiring | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 INFO confirmed |
| 2026-08-12 | `REVIEW_238_ipc-readiness-lifecycle-audit.md` | IPC readiness and lifecycle authority | 0 CRITICAL / 1 HIGH fixed / 4 MEDIUM fixed / 2 LOW fixed |
| 2026-08-12 | `REVIEW_237_remote-provider-readiness-and-history-parity.md` | Remote provider readiness and History parity | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-08-12 | `REVIEW_236_remote-source-visual-refresh.md` | Remote source visual hierarchy | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-08-12 | `REVIEW_235_async-local-file-read-audit.md` | Initial readiness and async local-file I/O | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-08-12 | `REVIEW_234_claude-uuid-rewrite-acceptance.md` | Claude deferred-input acceptance | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-12 | `REVIEW_233_remote-full-ui-parity.md` | Remote full UI parity and authority | 0 CRITICAL / all HIGH+MEDIUM fixed / no open findings |
