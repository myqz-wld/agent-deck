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
| 2026-07-31 | `REVIEW_209_review-208-defect-remediation.md` | Final integration of all REVIEW_208 findings | 0 CRITICAL / 4 HIGH fixed / 10 MEDIUM fixed / 1 LOW fixed |
| 2026-07-31 | `REVIEW_208_compatibility-and-defect-audit.md` | Compatibility cleanup and functional defect audit | 4 HIGH / 10 MEDIUM / 1 LOW; closed by REVIEW_209 |
| 2026-07-31 | `REVIEW_207_exit-worktree-output-schema-compatibility.md` | MCP Zod output validation | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-31 | `REVIEW_206_runtime-selector-hook-security.md` | Runtime selectors and Hook security | 2 HIGH fixed / 1 HIGH superseded / 5 MEDIUM fixed / 2 MEDIUM residual / 2 LOW fixed |
| 2026-07-31 | `REVIEW_205_internal-compatibility-pruning.md` | Second-pass internal compatibility pruning | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 3 LOW fixed |
| 2026-07-31 | `REVIEW_204_compatibility-cleanup.md` | Current-only compatibility cutover and codebase slimming | 0 CRITICAL / 1 HIGH fixed / 5 MEDIUM fixed / 2 LOW fixed |
| 2026-07-31 | `REVIEW_203_hook-config-and-development-navigation-safety.md` | Hook ownership and renderer reload safety | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-30 | `REVIEW_202_worktree-resume-recovery-race.md` | Revival-only worktree recovery | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-30 | `REVIEW_201_legacy-exit-worktree-adoption.md` | Bounded legacy worktree exit | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_200_automatic-worktree-transition-safety.md` | Automatic worktree cwd boundary | 0 CRITICAL / 3 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_199_grok-application-id-fence.md` | Grok stable identity deletion fence | 0 CRITICAL / 2 HIGH fixed |
| 2026-07-30 | `REVIEW_198_grok-extension-terminal-delivery.md` | Real Grok terminal delivery | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_197_runtime-log-signal-quality.md` | Runtime log signal quality | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_196_grok-durable-turn-delivery.md` | Durable Grok turn delivery | 0 CRITICAL / 2 HIGH fixed / 2 MEDIUM fixed |
| 2026-07-29 | `REVIEW_195_grok-live-acp-terminal.md` | Grok live ACP completion delivery | 0 CRITICAL / 2 HIGH fixed / 2 MEDIUM fixed |
| 2026-07-29 | `REVIEW_194_claude-gateway-sandbox-startup.md` | Claude Gateway sandbox startup | 0 CRITICAL / 2 HIGH fixed |
| 2026-07-29 | `REVIEW_193_grok-delivery-token-metric-scope.md` | Provider delivery, interrupts, and token fidelity | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed / 1 INFO |
| 2026-07-29 | `REVIEW_192_grok-acp-silent-turn-recovery.md` | Grok ACP silent-turn recovery | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-29 | `REVIEW_191_expandable-dialog-close-control.md` | Expandable dialog close control | 0 CRITICAL / 0 HIGH / 1 LOW fixed |
| 2026-07-29 | `REVIEW_190_first-message-image-control-spacing.md` | First-message image control spacing | 0 CRITICAL / 0 HIGH / 1 LOW fixed |
| 2026-07-29 | `REVIEW_189_grok-pending-chat-duplication.md` | Grok pending/chat duplication | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-29 | `REVIEW_188_maintenance-timeout-terminal-policy.md` | Storage maintenance terminal timeout policy | 0 CRITICAL / 1 HIGH fixed / 1 LOW residual |
| 2026-07-29 | `REVIEW_187_whole-project-quality-refresh.md` | Whole-project final integration and performance audit | 0 CRITICAL / 4 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed / 5 residuals |
| 2026-07-27 | `REVIEW_186_adapter-hook-contract-normalization.md` | Cross-adapter hook contract normalization | 0 CRITICAL / 4 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed |
| 2026-07-27 | `REVIEW_185_codex-mcp-lifecycle-approval-bridge.md` | Codex MCP lifecycle approval bridge | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-27 | `REVIEW_184_transparent-usage-refresh-latency.md` | Transparent artifact and provider refresh latency | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-27 | `REVIEW_183_token-usage-visibility-regression.md` | Daily token aggregate visibility regression | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed / 2 LOW fixed |
| 2026-07-27 | `REVIEW_182_browser-engine-p0-p1-solo-audit.md` | Browser P0/P1 standalone Codex audit | 0 CRITICAL / 5 HIGH fixed / 6 MEDIUM fixed / 1 LOW fixed |
| 2026-07-27 | `REVIEW_181_provider-usage-runtime-control-fidelity.md` | Provider usage and runtime-control fidelity | Final PASS; AFR-001–012 closed |
| 2026-07-27 | `REVIEW_180_bundled-grok-package-preflight.md` | Bundled Grok package completeness | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-27 | `REVIEW_179_transparent-scroll-compositor.md` | Transparent scroll compositor audit | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-27 | `REVIEW_178_grok-tool-rendering-transparent-compositor.md` | Grok tool-event identity and transparent-window compositor refresh | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-26 | `REVIEW_177_session-owned-iab-backend.md` | Session-owned Browser backend and dependency refresh | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed |
| 2026-07-26 | `REVIEW_176_agent-plugin-recovery-state.md` | Claude/Grok Agent and Plugin recovery state | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed |
| 2026-07-26 | `REVIEW_175_node-repl-browser-process-bootstrap.md` | Browser process bootstrap compatibility | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-26 | `REVIEW_174_grok-custom-assets-test-isolation.md` | Grok custom-assets test isolation | 0 CRITICAL / 0 HIGH / 1 LOW fixed |
| 2026-07-26 | `REVIEW_173_tool-input-alias-recursion.md` | Renderer tool-summary alias recursion | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-25 | `REVIEW_172_asset-library-cross-adapter-display.md` | Cross-adapter asset discovery and card layout | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-24 | `REVIEW_171_grok-token-usage-data-panel.md` | Grok token usage, history backfill, and live rates | 0 CRITICAL / 3 HIGH fixed / 2 MEDIUM fixed |
| 2026-07-24 | `REVIEW_170_grok-mid-turn-interjection.md` | Grok active-turn input and FIFO fallback | 0 CRITICAL / 2 HIGH fixed / 2 MEDIUM fixed |
| 2026-07-23 | `REVIEW_169_grok-auth-asset-boundaries.md` | Grok ACP authentication and asset-edit boundaries | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-23 | `REVIEW_168_bundled-agent-runtime-overrides.md` | Bundled Agent runtime override boundaries | 0 CRITICAL / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-07-23 | `REVIEW_167_grok-build-adapter-boundaries.md` | Grok ACP lifecycle and adapter-profile boundaries | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed |
| 2026-07-22 | `REVIEW_166_node-repl-sandbox-protocol.md` | Codex browser sandbox metadata compatibility | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-21 | `REVIEW_165_plan-review-message-consumption.md` | Review isolation and message-consumption boundaries | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-07-16 | `REVIEW_164_checkpoint-partial-progress-logging.md` | Checkpoint partial-progress log classification | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-15 | `REVIEW_163_checkpoint-patch-reduction.md` | Deterministic checkpoint patch reduction | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-15 | `REVIEW_162_runtime-log-signal-and-recovery.md` | Runtime log signal, checkpoint recovery, and navigation containment | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-14 | `REVIEW_161_handoff-ownership-plan-review-hardening.md` | Current-owner authority and plan-review lifecycle | 0 CRITICAL / 5 HIGH fixed / 13 MEDIUM fixed / 5 LOW fixed |
| 2026-07-14 | `REVIEW_160_checkpoint-lifecycle.md` | Automatic bounded continuation checkpoints | 0 CRITICAL / 3 HIGH fixed / 5 MEDIUM fixed / 6 LOW fixed |
| 2026-07-14 | `REVIEW_159_present-plan-lifecycle.md` | Blocking plan gate and isolated review fork | 0 CRITICAL / 0 HIGH / 5 MEDIUM fixed / 1 LOW fixed |
| 2026-07-14 | `REVIEW_158_handoff-context-coverage.md` | Runtime persistence and hand-off context coverage | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW residual |
| 2026-07-13 | `REVIEW_157_codex-first-model-event-watchdog.md` | Codex accepted-turn recovery | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed / 1 LOW fixed + 3 residuals |
| 2026-07-12 | `REVIEW_156_codex-mcp-synchronized-readiness.md` | Synchronized Codex MCP readiness isolation | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-12 | `REVIEW_155_handoff-cutover-continuity.md` | Message-safe session handoff cutover | 0 CRITICAL / 7 HIGH fixed / 6 MEDIUM fixed / 2 LOW fixed |
| 2026-07-12 | `REVIEW_154_core-snapshot-ui-copy.md` | Core snapshot integrity and concise UI copy | 0 CRITICAL / 1 HIGH fixed / 4 MEDIUM fixed / 3 LOW fixed |
| 2026-07-12 | `REVIEW_153_storage-maintenance-worker-provider-compaction.md` | Dedicated storage worker and provider compact runtime | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-11 | `REVIEW_152_storage-performance-observability-svg-icons.md` | Storage migration, MCP readiness, and SVG icons | 0 CRITICAL / 5 HIGH fixed / 6 MEDIUM fixed / 2 LOW residuals |
| 2026-07-11 | `REVIEW_151_send-message-performance-and-logging.md` | Send latency, storage, and runtime logging | 0 CRITICAL / 1 HIGH tracked / 2 MEDIUM fixed + 1 tracked / 2 LOW dispositioned |
| 2026-07-11 | `REVIEW_150_core-session-integrity.md` | Handoff and spawn session integrity | 1 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed / 2 dispositioned |
| 2026-07-11 | `REVIEW_149_session-pinning-reviewer-model.md` | Persistent session pinning and Codex reviewer runtime | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-11 | `REVIEW_148_unified-continuation-context.md` | Unified Continuation Context implementation | 0 CRITICAL / 4 HIGH fixed / 4 MEDIUM fixed |
