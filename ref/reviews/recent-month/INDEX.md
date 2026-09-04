# Recent Month Reviews

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
| 2026-08-27 | `REVIEW_265_system-status-session-readiness.md` | System status and Claude startup consistency | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 2 LOW fixed |
| 2026-08-24 | `REVIEW_264_session-authoring-interaction-stability.md` | Session authoring and History interaction stability | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-08-24 | `REVIEW_263_session-settings-clarity.md` | Session settings clarity and Hook timeout | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 3 LOW fixed |
| 2026-08-24 | `REVIEW_262_native-project-trust.md` | Native project trust security and lifecycle | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed / 2 LOW fixed |
| 2026-08-23 | `REVIEW_261_session-config-read-latency.md` | Session config read latency | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-08-21 | `REVIEW_260_global-async-navigation-readiness.md` | Global asynchronous navigation readiness | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed / 1 LOW fixed |
| 2026-08-20 | `REVIEW_259_global-action-layout-stability.md` | Global dynamic-action and 150 ms layout stability | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-08-20 | `REVIEW_258_session-create-button-stability.md` | Session create-button presentation stability | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-08-20 | `REVIEW_257_session-creation-readiness-and-stall.md` | Session creation readiness and stall diagnostics | 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed |
| 2026-08-19 | `REVIEW_256_iab-annotation-capture-race.md` | IAB annotation capture race remediation | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-08-18 | `REVIEW_255_unified-browser-boundary-review.md` | Unified Browser security and lifecycle boundaries | 0 CRITICAL / 0 HIGH / 0 MEDIUM / no open findings |
| 2026-08-18 | `REVIEW_254_summary-settings-layout-and-timeout-policy.md` | Summary settings layout and timeout policy | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed |
| 2026-08-18 | `REVIEW_253_current-only-gap-sweep.md` | Current-only coverage-gap sweep | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 3 LOW fixed |
| 2026-08-17 | `REVIEW_252_current-only-compatibility-sweep.md` | Current-only compatibility sweep | 0 CRITICAL / 0 HIGH / 6 MEDIUM fixed / 2 LOW fixed |
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
| 2026-08-09 | `REVIEW_221_podman-health-json-argv.md` | Podman health command argv semantics | 0 CRITICAL / 1 HIGH fixed |
| 2026-08-09 | `REVIEW_220_relay-image-exact-node-runtime.md` | Exact Node path in the Relay image | 0 CRITICAL / 1 HIGH fixed |
| 2026-08-09 | `REVIEW_219_relay-health-startup-gate.md` | Relay health-gated systemd activation | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed |
| 2026-08-09 | `REVIEW_218_closed-reviewer-runtime-retirement.md` | Closed reviewer runtime retirement | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-08-09 | `REVIEW_217_remote-parity-finalization.md` | Remote parity residual lifecycle review | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed / 1 INFO fixed |
| 2026-08-08 | `REVIEW_216_handoff-lifecycle-context-v2.md` | Handoff context and ownership hardening | 0 CRITICAL / all HIGH+MEDIUM fixed / 1 LOW accepted / 6 residuals |
