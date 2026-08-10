# Recent Month Changelogs

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
| 2026-08-03 | `CHANGELOG_431_concise-session-empty-state.md` | Simplify the session-list empty-state guidance |
| 2026-08-03 | `CHANGELOG_430_context-window-observation-unification.md` | Unify observed context capacity across continuations |
| 2026-08-03 | `CHANGELOG_429_hook-ownership-and-provider-dependencies.md` | Keep hooks idempotent and refresh provider dependencies |
| 2026-08-03 | `CHANGELOG_428_provider-token-accounting-and-rate-repair.md` | Repair provider token totals and tok/s calibration |
| 2026-07-31 | `CHANGELOG_427_compatibility-and-defect-remediation.md` | Clean compatibility seams and close all REVIEW_208 defects |
| 2026-07-31 | `CHANGELOG_426_exit-worktree-output-schema-compatibility.md` | Publish a callable exit_worktree result schema |
| 2026-07-31 | `CHANGELOG_425_codex-provider-hook-runtime-hardening.md` | Restore Codex providers and harden Hook/runtime boundaries |
| 2026-07-31 | `CHANGELOG_424_plan-review-expandable-inputs.md` | Replace deep-review field resizing with expand actions |
| 2026-07-31 | `CHANGELOG_423_adapter_native_gateway_profile_selectors.md` | Use Claude Gateway and native Codex profile selectors |
| 2026-07-31 | `CHANGELOG_422_retired_codex_user_config_ownership.md` | Stop owning or cleaning native Codex user configuration |
| 2026-07-31 | `CHANGELOG_421_spawn-session-model-suggestions.md` | Remove stale GPT and Deepseek spawn model suggestions |
| 2026-07-31 | `CHANGELOG_420_archive-plan-dead-code-removal.md` | Remove retired archive plan MCP code and orphaned cleanup paths |
| 2026-07-30 | `CHANGELOG_419_branch-independent-worktree-lifecycle.md` | Isolate worktree lifecycle from branches and refs |
| 2026-07-30 | `CHANGELOG_418_automatic-worktree-cwd-transition.md` | Move sessions across worktrees at an automatic safe turn boundary |
| 2026-07-30 | `CHANGELOG_417_session-list-runtime-metadata.md` | Show branch and context occupancy on live session cards |
| 2026-07-30 | `CHANGELOG_416_handoff-context-usage.md` | Fix hand-off fields and show live context occupancy |
| 2026-07-30 | `CHANGELOG_415_hook-event-lifecycle-completeness.md` | Capture lifecycle hooks and close incomplete Codex tool activity |
| 2026-07-29 | `CHANGELOG_414_post-acceptance-delivery-durability.md` | Prevent uncertain message redelivery after adapter acceptance |
| 2026-07-29 | `CHANGELOG_413_session-ui-scope-alignment.md` | Restore scoped expand controls and align session runtime labels |
| 2026-07-29 | `CHANGELOG_412_maintenance-timeout-terminal-policy.md` | Disable storage maintenance until restart after a worker timeout |
| 2026-07-29 | `CHANGELOG_411_whole-project-quality-refresh.md` | Harden runtime, storage, UI, logging, dependencies, and packaging |
| 2026-07-28 | `CHANGELOG_410_codex-live-approval-review-runtime.md` | Expose live Codex approvals and make review runtime prompt-owned |
| 2026-07-27 | `CHANGELOG_409_session-runtime-defaults-ui.md` | Default Codex approvals and align session runtime inheritance |
| 2026-07-27 | `CHANGELOG_408_concrete-session-creation-defaults.md` | Resolve and show concrete defaults in compact new-session controls |
| 2026-07-27 | `CHANGELOG_407_codex-session-approval-policy.md` | Choose Codex approval policy when creating human sessions |
| 2026-07-27 | `CHANGELOG_406_grok-native-sandbox-controls.md` | Control Grok Build's native sandbox across every session path |
| 2026-07-27 | `CHANGELOG_405_transparent-usage-refresh-latency.md` | Clear transparent artifacts and bound provider refresh latency |
| 2026-07-27 | `CHANGELOG_404_token-usage-presence-repair.md` | Restore daily token totals without weakening strict provider totals |
| 2026-07-27 | `CHANGELOG_403_browser-waits-open-dom-retention.md` | Add browser waits, open-DOM refs, and seven-day screenshot retention |
| 2026-07-27 | `CHANGELOG_402_provider-usage-runtime-control-fidelity.md` | Preserve provider usage and adapter-owned runtime controls |
| 2026-07-27 | `CHANGELOG_401_concurrent-batch-review.md` | Preserve adversarial review across concurrent scope batches |
| 2026-07-27 | `CHANGELOG_400_cross-adapter-browser-engine.md` | Open the in-app browser to every adapter through MCP browser tools |
| 2026-07-27 | `CHANGELOG_399_data-token-summary-alignment.md` | Align the daily token summary with neighboring Data sections |
| 2026-07-26 | `CHANGELOG_398_session-owned-iab-dependency-refresh.md` | Add session-owned IAB and refresh provider dependencies |
| 2026-07-26 | `CHANGELOG_397_agent-plugin-recovery-state.md` | Preserve Claude and Grok Agent/Plugin state across recovery |
| 2026-07-26 | `CHANGELOG_396_resumable-plan-deep-review.md` | Keep plan deep-review replies running across close and view changes |
| 2026-07-25 | `CHANGELOG_395_read-only-plugin-assets.md` | Align read-only direct and Plugin assets across all adapters |
| 2026-07-24 | `CHANGELOG_394_grok-native-assets.md` | Support Grok native Agents, Skills, and plugin discovery |
| 2026-07-24 | `CHANGELOG_393_unified-token-accounting.md` | Unify token totals and included breakdowns in the Data tab |
| 2026-07-24 | `CHANGELOG_392_bundled-grok-cli.md` | Use the bundled Grok CLI by default with external override support |
| 2026-07-24 | `CHANGELOG_391_claude-codex-grok-dependencies.md` | Refresh Claude, Codex, and Grok runtime dependencies |
| 2026-07-24 | `CHANGELOG_390_provider-acceptance-message-lifecycle.md` | Align message visibility with provider acceptance |
| 2026-07-24 | `CHANGELOG_389_grok-token-usage-data-panel.md` | Collect Grok usage and show historical/live token rates |
| 2026-07-24 | `CHANGELOG_388_grok-mid-turn-interjection.md` | Support Grok active-turn input with safe FIFO fallback |
| 2026-07-23 | `CHANGELOG_387_runtime-provider-gateway-unification.md` | Unify Gateway/model providers and add Grok quota |
| 2026-07-23 | `CHANGELOG_386_grok-generators-external-hooks.md` | Add Grok generators and external terminal Hook capture |
| 2026-07-23 | `CHANGELOG_385_grok-settings-auth-assets.md` | Add Grok ACP auth, editable conventions, and xhigh support |
| 2026-07-23 | `CHANGELOG_384_bundled-agent-runtime-overrides.md` | Configure bundled Agent runtime model, thinking, and Codex provider |
| 2026-07-23 | `CHANGELOG_383_grok-build-adapter-profiles.md` | Add Grok Build as a first-class adapter |
| 2026-07-23 | `CHANGELOG_382_plan-review-feedback-discard-confirmation.md` | Confirm before approval discards plan-review feedback |
| 2026-07-22 | `CHANGELOG_381_pending-image-previews.md` | Show pending image details and full-size previews in composers |
| 2026-07-22 | `CHANGELOG_380_node-repl-sandbox-compatibility.md` | Bridge legacy node_repl sandbox metadata and refresh agent runtimes |
| 2026-07-21 | `CHANGELOG_379_plan-review-pending-queue-composer.md` | Isolate plan review and preserve pending input until consumption |
| 2026-07-16 | `CHANGELOG_378_plan-review-chat-feedback.md` | Align decision controls and show deep-review reply progress |
| 2026-07-16 | `CHANGELOG_377_worktree-lifecycle-contract.md` | Clarify default worktrees and require consent before branch deletion |
| 2026-07-15 | `CHANGELOG_376_plan-review-quote-and-decision-tray.md` | Refine deep-review quotes, decisions, and feedback confirmation |
| 2026-07-15 | `CHANGELOG_375_claude-codex-patch-releases.md` | Advance packaged Claude Agent SDK and Codex CLI patch releases |
| 2026-07-15 | `CHANGELOG_374_history-search-case-insensitive.md` | Make History search case-insensitive through an offline FTS rebuild |
| 2026-07-15 | `CHANGELOG_373_review-skill-lifecycle.md` | Separate simple and deep review lifecycles |
| 2026-07-15 | `CHANGELOG_372_asset-library-card-copy.md` | Align asset-library controls and Agent metadata |
| 2026-07-15 | `CHANGELOG_371_deepseek-summary-haiku-default.md` | Use Haiku as the blank Deepseek summary model |
| 2026-07-15 | `CHANGELOG_370_continuation-checkpoint-concurrency.md` | Bound concurrent continuation checkpoint refreshes |
| 2026-07-15 | `CHANGELOG_369_claude-codex-dependencies.md` | Refresh packaged Claude Agent SDK and Codex CLI dependencies |
| 2026-07-15 | `CHANGELOG_368_settings-panel-alignment.md` | Align settings copy, sandbox controls, and default reset |
| 2026-07-14 | `CHANGELOG_367_summary-refresh-thresholds.md` | Raise summary and checkpoint refresh thresholds |
| 2026-07-14 | `CHANGELOG_366_handoff-ownership-plan-review-hardening.md` | Preserve hand-off ownership and harden plan review |
| 2026-07-14 | `CHANGELOG_365_automatic-continuation-checkpoints.md` | Keep continuation checkpoints fresh and bounded |
| 2026-07-14 | `CHANGELOG_364_present-plan-deep-review.md` | Retain blocking plan gates and add isolated contextual review |
| 2026-07-14 | `CHANGELOG_363_runtime-controls-handoff-context.md` | Auto-save runtime controls and keep hand-off context current |
| 2026-07-12 | `CHANGELOG_362_storage-maintenance-worker-provider-compaction.md` | Isolate live storage maintenance and restore Codex compact generation |
