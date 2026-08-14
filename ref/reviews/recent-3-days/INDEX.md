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
| 2026-08-13 | `REVIEW_245_feishu-p0-surface-cleanup.md` | Dormant product surface removal | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
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
| 2026-08-11 | `REVIEW_232_remote-transport-ui-convergence.md` | Remote transport and UI convergence | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 3 LOW fixed |
| 2026-08-11 | `REVIEW_231_remote-replay-bootstrap.md` | Remote replay bootstrap and Feishu gate | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-08-11 | `REVIEW_230_remote-session-continuity.md` | Remote continuity and active input | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 2 LOW fixed / 1 INFO resolved |
| 2026-08-11 | `REVIEW_229_remote-worker-ui-authority.md` | Remote UI and Worker authority | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed / 3 INFO fixed |
| 2026-08-10 | `REVIEW_228_remote-token-usage-ingest.md` | Remote token telemetry persistence | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-10 | `REVIEW_227_remote-source-reconnect.md` | Persisted Remote source restoration | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-10 | `REVIEW_226_remote-full-page-parity.md` | Remote full-page parity and authority | 0 CRITICAL / 2 HIGH fixed / 3 MEDIUM fixed / 2 LOW fixed / 1 LOW accepted |
| 2026-08-10 | `REVIEW_225_headless-provider-sdk-resolution.md` | Headless provider SDK resolution | 0 CRITICAL / 2 HIGH fixed |
| 2026-08-10 | `REVIEW_224_macos-worker-clean-exit-recovery.md` | Always-on Worker clean-exit recovery | 0 CRITICAL / 1 HIGH fixed / 0 MEDIUM |
| 2026-08-10 | `REVIEW_223_same-release-deploy-idempotency.md` | Same-release managed deploy recovery | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-10 | `REVIEW_222_linux-deployment-automation.md` | Managed deployment safety and lifecycle | 0 CRITICAL / 3 HIGH fixed / 7 MEDIUM fixed |
