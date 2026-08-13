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
| 2026-08-05 | `CHANGELOG_567_single-reviewer-finding-verification.md` | Verify un-rebutted single-worker findings before use |
| 2026-08-05 | `CHANGELOG_566_adapter-runtime-event-fidelity.md` | Refresh runtimes and restore native-agent/tool visibility |
| 2026-08-05 | `CHANGELOG_564_relay-worker-live-ssh-path.md` | Close the live Relay Worker SSH path |
| 2026-08-05 | `CHANGELOG_563_concrete-headless-server-core-runtime.md` | Package the concrete headless Server Core |
| 2026-08-05 | `CHANGELOG_562_codex-aggregate-host-core.md` | Compose the headless Codex host |
| 2026-08-05 | `CHANGELOG_561_claude-aggregate-host-core.md` | Compose the headless Claude host |
| 2026-08-05 | `CHANGELOG_560_grok-aggregate-host-core.md` | Compose the headless Grok host |
| 2026-08-05 | `CHANGELOG_559_hook-route-diagnostics-core-boundary.md` | Port hook route diagnostics |
| 2026-08-05 | `CHANGELOG_558_grok-hook-installer-observer-boundary.md` | Port Grok hook diagnostics |
| 2026-08-05 | `CHANGELOG_557_provider-adapter-set-core-boundary.md` | Construct isolated provider sets |
| 2026-08-05 | `CHANGELOG_556_provider-adapter-context-port-boundary.md` | Port provider context ownership |
| 2026-08-05 | `CHANGELOG_555_provider-adapter-core-composition-boundary.md` | Publish three provider Adapter classes as Node cores |
| 2026-08-05 | `CHANGELOG_554_grok-build-bridge-runtime-host-boundary.md` | Bundle the complete Grok Build bridge |
| 2026-08-05 | `CHANGELOG_553_codex-sdk-bridge-runtime-host-boundary.md` | Bundle the complete Codex SDK bridge |
| 2026-08-05 | `CHANGELOG_552_codex-recovery-continuation-host-injection.md` | Inject Codex recovery continuation ownership |
| 2026-08-05 | `CHANGELOG_551_claude-sdk-bridge-node-boundary.md` | Bundle the complete Claude SDK bridge |
| 2026-08-05 | `CHANGELOG_550_claude-recovery-node-boundary.md` | Bundle complete Claude recovery paths |
| 2026-08-05 | `CHANGELOG_549_safe-diagnostic-text-core-boundary.md` | Publish safe diagnostic text Core |
| 2026-08-05 | `CHANGELOG_548_claude-recovery-diagnostic-host-injection.md` | Inject Claude recovery diagnostics |
| 2026-08-05 | `CHANGELOG_547_claude-jsonl-fallback-diagnostic-injection.md` | Inject JSONL fallback diagnostics |
| 2026-08-05 | `CHANGELOG_546_claude-restart-diagnostic-host-injection.md` | Inject Claude restart diagnostics |
| 2026-08-05 | `CHANGELOG_545_claude-sdk-query-host-injection.md` | Inject Claude SDK query composition |
| 2026-08-05 | `CHANGELOG_544_claude-can-use-tool-host-injection.md` | Inject Claude tool decisions |
| 2026-08-05 | `CHANGELOG_543_claude-session-finalize-host-injection.md` | Inject Claude creation finalization |
| 2026-08-05 | `CHANGELOG_542_claude-stream-processor-host-injection.md` | Inject Claude stream ownership |
| 2026-08-05 | `CHANGELOG_541_claude-pending-outgoing-host-injection.md` | Inject Claude pending-outgoing ownership |
| 2026-08-05 | `CHANGELOG_540_claude-session-lifecycle-host-injection.md` | Inject Claude lifecycle ownership |
| 2026-08-05 | `CHANGELOG_539_claude-message-controller-host-injection.md` | Inject Claude message ingress |
| 2026-08-05 | `CHANGELOG_538_claude-cwd-transition-host-injection.md` | Inject Claude transition reads |
| 2026-08-05 | `CHANGELOG_537_claude-permission-responder-host-injection.md` | Inject Claude permission persistence |
| 2026-08-05 | `CHANGELOG_536_claude-usage-snapshot-host-injection.md` | Inject Claude usage probing |
| 2026-08-05 | `CHANGELOG_535_claude-jsonl-discovery-host-injection.md` | Inject Claude transcript probes |
| 2026-08-05 | `CHANGELOG_534_claude-session-model-host-injection.md` | Inject Claude model persistence |
| 2026-08-05 | `CHANGELOG_533_claude-live-gateway-host-reuse.md` | Reuse the Claude Gateway host |
| 2026-08-05 | `CHANGELOG_532_claude-recovery-freshness-host-injection.md` | Inject Claude freshness reads |
| 2026-08-05 | `CHANGELOG_531_claude-restart-session-host-injection.md` | Inject Claude restart ownership |
| 2026-08-05 | `CHANGELOG_530_claude-recovery-session-reader-injection.md` | Inject Claude recovery reads |
| 2026-08-05 | `CHANGELOG_529_claude-create-session-host-injection.md` | Inject Claude create ownership |
| 2026-08-05 | `CHANGELOG_528_claude-usage-session-manager-boundary.md` | Inject Claude usage ownership |
| 2026-08-05 | `CHANGELOG_527_claude-lifecycle-session-manager-boundary.md` | Inject Claude lifecycle ownership |
| 2026-08-05 | `CHANGELOG_526_claude-stream-session-manager-boundary.md` | Inject Claude stream ownership |
| 2026-08-05 | `CHANGELOG_525_claude-recovery-session-manager-boundary.md` | Inject Claude recovery ownership |
| 2026-08-05 | `CHANGELOG_524_claude-session-manager-port-boundary.md` | Inject Claude session ownership |
| 2026-08-05 | `CHANGELOG_523_grok-session-manager-host-boundary.md` | Inject Grok session ownership |
| 2026-08-05 | `CHANGELOG_522_session-manager-facade-core-boundary.md` | Inject the SessionManager host |
| 2026-08-05 | `CHANGELOG_521_session-lifecycle-core-boundary.md` | Isolate session lifecycle orchestration |
| 2026-08-05 | `CHANGELOG_520_provider-runtime-composition-core-boundary.md` | Share provider startup composition outside Electron |
| 2026-08-05 | `CHANGELOG_519_session-creation-defaults-host-hardening.md` | Remove hidden provider defaults |
| 2026-08-05 | `CHANGELOG_518_session-model-controller-core-boundary.md` | Isolate model-option rollback |
| 2026-08-05 | `CHANGELOG_517_claude-stream-processor-core-boundary.md` | Isolate Claude stream composition |
| 2026-08-05 | `CHANGELOG_516_claude-stream-wait-core-boundary.md` | Bound Claude first-message startup |
| 2026-08-05 | `CHANGELOG_515_claude-stream-session-identity-core-boundary.md` | Fence Claude stream identities |
| 2026-08-05 | `CHANGELOG_514_claude-stream-finalize-core-boundary.md` | Isolate Claude stream retirement |
| 2026-08-05 | `CHANGELOG_513_claude-sdk-message-translate-core-boundary.md` | Publish Claude message translation Core |
| 2026-08-05 | `CHANGELOG_512_claude-message-file-changes-core-boundary.md` | Gate translated file-change state |
| 2026-08-05 | `CHANGELOG_511_claude-message-translation-state-core-boundary.md` | Isolate translator state ownership |
| 2026-08-05 | `CHANGELOG_510_claude-context-usage-core-boundary.md` | Gate context attribution Core |
| 2026-08-05 | `CHANGELOG_509_claude-final-result-usage-core-boundary.md` | Gate usage reconciliation Core |
| 2026-08-05 | `CHANGELOG_508_claude-user-message-acceptance-core-boundary.md` | Port provider echo acceptance |
| 2026-08-05 | `CHANGELOG_507_claude-pending-outgoing-core-boundary.md` | Port pending queue authority |
| 2026-08-05 | `CHANGELOG_506_claude-query-options-builder-core-boundary.md` | Port SDK option policy |
| 2026-08-05 | `CHANGELOG_505_claude-gateway-profiles-core-boundary.md` | Port Gateway profile policy |
| 2026-08-05 | `CHANGELOG_504_claude-cwd-transition-controller-core-boundary.md` | Port cwd replacement state |
| 2026-08-05 | `CHANGELOG_503_claude-jsonl-discovery-core-boundary.md` | Port recovery transcript probes |
| 2026-08-05 | `CHANGELOG_502_claude-sdk-runtime-core-boundary.md` | Port SDK runtime and binary selection |
| 2026-08-05 | `CHANGELOG_501_claude-gateway-sandbox-settings-core-boundary.md` | Port Gateway sandbox derivation |
| 2026-08-05 | `CHANGELOG_500_claude-gateway-fork-safety-core-boundary.md` | Port transcript-root admission |
| 2026-08-05 | `CHANGELOG_499_claude-permission-responder-core-boundary.md` | Port pending responses |
| 2026-08-05 | `CHANGELOG_498_claude-user-message-stream-core-boundary.md` | Port queued user input |
| 2026-08-05 | `CHANGELOG_497_claude-can-use-tool-core-boundary.md` | Port tool permission decisions |
| 2026-08-05 | `CHANGELOG_496_claude-message-controller-core-boundary.md` | Port Claude message ingress policy into Core |
| 2026-08-05 | `CHANGELOG_495_claude-hook-installer-core-boundary.md` | Publish Claude hook installation as a Node Core |
| 2026-08-05 | `CHANGELOG_494_claude-settings-env-core-boundary.md` | Port Claude settings environment policy into Core |
| 2026-08-05 | `CHANGELOG_493_claude-sandbox-config-core-boundary.md` | Port Claude sandbox option policy into Core |
| 2026-08-05 | `CHANGELOG_492_claude-native-fork-core-boundary.md` | Port Claude native-fork orchestration into Core |
| 2026-08-05 | `CHANGELOG_491_claude-usage-snapshot-host-boundary.md` | Port Claude account usage probing behind a host |
| 2026-08-05 | `CHANGELOG_490_claude-fork-cleanup-core-boundary.md` | Port Claude native-fork discard aggregation into Core |
| 2026-08-05 | `CHANGELOG_489_claude-session-finalize-core-boundary.md` | Port Claude session registration sequencing into Core |
| 2026-08-05 | `CHANGELOG_488_claude-pending-cancellation-core-boundary.md` | Port Claude close cleanup state into Core |
| 2026-08-05 | `CHANGELOG_487_claude-session-lifecycle-core-boundary.md` | Port Claude live-session lifecycle into Core |
| 2026-08-05 | `CHANGELOG_486_claude-session-defaults-host-boundary.md` | Port Claude create defaults behind one host |
| 2026-08-05 | `CHANGELOG_485_claude-runtime-metadata-host-boundary.md` | Port Claude runtime metadata decisions into Core |
| 2026-08-05 | `CHANGELOG_484_claude-live-token-rate-host-boundary.md` | Port Claude live decode-rate state behind a host |
| 2026-08-05 | `CHANGELOG_483_codex-live-token-rate-host-boundary.md` | Port Codex live usage state behind a desktop host |
| 2026-08-05 | `CHANGELOG_482_grok-live-token-rate-observer-boundary.md` | Port Grok live token-rate state behind an observer |
| 2026-08-05 | `CHANGELOG_481_browser-tab-collection-core-boundary.md` | Port per-owner browser tab state into Core |
| 2026-08-05 | `CHANGELOG_480_browser-ownership-registry-core-boundary.md` | Port browser owner lifecycle into Core |
| 2026-08-05 | `CHANGELOG_479_claude-sdk-injection-host-boundary.md` | Port Claude SDK injection discovery behind a host |
| 2026-08-05 | `CHANGELOG_478_grok-adapter-host-boundary.md` | Port Grok adapter composition behind a host |
| 2026-08-05 | `CHANGELOG_477_codex-adapter-init-host-boundary.md` | Port Codex adapter construction behind a host |
| 2026-08-05 | `CHANGELOG_476_claude-adapter-init-host-boundary.md` | Port Claude adapter construction behind a host |
| 2026-08-05 | `CHANGELOG_475_claude-mcp-server-host-boundary.md` | Port Claude MCP attachment behind a host |
| 2026-08-05 | `CHANGELOG_474_codex-summary-runner-host-boundary.md` | Port Codex periodic summary policy behind a host |
| 2026-08-05 | `CHANGELOG_473_grok-summary-runner-host-boundary.md` | Port Grok periodic summaries behind a settings host |
| 2026-08-05 | `CHANGELOG_472_codex-instance-pool-host-boundary.md` | Port the Codex oneshot instance pool behind a host |
| 2026-08-05 | `CHANGELOG_471_codex-usage-snapshot-host-boundary.md` | Port background Codex quota composition behind a host |
| 2026-08-05 | `CHANGELOG_470_codex-client-construction-boundary.md` | Port per-session Codex client construction behind a host |
| 2026-08-05 | `CHANGELOG_469_codex-live-create-runtime-boundary.md` | Port Codex live create/resume runtime selection to Core |
| 2026-08-05 | `CHANGELOG_468_codex-fork-runtime-host-boundary.md` | Inject Codex native-fork runtime settings through a host |
| 2026-08-05 | `CHANGELOG_467_session-creation-defaults-core-boundary.md` | Inject provider defaults into a Node-only Core resolver |
| 2026-08-05 | `CHANGELOG_466_adapter-registry-core-boundary.md` | Separate provider registry Core from desktop diagnostics |
| 2026-08-05 | `CHANGELOG_465_storage-maintenance-worker-host-boundary.md` | Port storage maintenance worker composition behind a host |
| 2026-08-05 | `CHANGELOG_464_checkpoint-background-worker-host-boundary.md` | Port background checkpoint worker construction behind a host |
| 2026-08-05 | `CHANGELOG_463_checkpoint-backlog-worker-host-boundary.md` | Port checkpoint backlog worker construction behind a host |
| 2026-08-05 | `CHANGELOG_462_codex-app-server-client-host-boundary.md` | Publish the complete Codex app-server client Node candidate |
| 2026-08-05 | `CHANGELOG_461_codex-client-lifecycle-host-boundary.md` | Inject Codex lifecycle observers through the app-server host |
| 2026-08-05 | `CHANGELOG_460_codex-app-server-process-host-boundary.md` | Inject Codex app-server process startup through the client host |
| 2026-08-05 | `CHANGELOG_459_codex-client-diagnostics-boundary.md` | Port Codex process diagnostics out of the app-server client |
| 2026-08-05 | `CHANGELOG_458_codex-thread-diagnostics-boundary.md` | Port Codex turn watchdog diagnostics out of the thread state machine |
| 2026-08-05 | `CHANGELOG_457_codex-event-translation-diagnostics-boundary.md` | Port Codex translation diagnostics out of the event boundary |
| 2026-08-05 | `CHANGELOG_456_codex-mcp-startup-observer-boundary.md` | Extract Codex MCP startup observation from desktop process state |
| 2026-08-05 | `CHANGELOG_455_codex-node-repl-browser-bootstrap-boundary.md` | Extract Codex Browser bootstrap policy behind host ports |
| 2026-08-05 | `CHANGELOG_454_codex-generation-diagnostics-boundary.md` | Port Codex generation lifecycle diagnostics out of the controller |
| 2026-08-05 | `CHANGELOG_453_codex-usage-probe-store-boundary.md` | Extract Codex quota probing behind a bounded Node store |
| 2026-08-05 | `CHANGELOG_452_claude-runtime-selection-boundary.md` | Extract Claude sandbox and model precedence into a pure policy |
| 2026-08-05 | `CHANGELOG_451_codex-instance-pool-store-boundary.md` | Extract Codex oneshot client caching behind a Node store |
| 2026-08-05 | `CHANGELOG_450_claude-binary-resolution-boundary.md` | Extract Claude binary selection behind explicit host ports |
| 2026-08-05 | `CHANGELOG_449_codex-skills-mirror-store-boundary.md` | Extract Codex skills publication behind a Node store |
| 2026-08-05 | `CHANGELOG_448_claude-plugin-mirror-store-boundary.md` | Extract Claude plugin publication behind a Node store |
| 2026-08-05 | `CHANGELOG_447_bundled-asset-store-boundary.md` | Extract bundled asset filesystem ownership behind a Node store |
| 2026-08-05 | `CHANGELOG_446_resource-placeholder-transformer-boundary.md` | Extract resource placeholder transforms behind a Node boundary |
| 2026-08-05 | `CHANGELOG_445_codex-skills-manifest-boundary.md` | Extract the Codex skills mirror codec |
| 2026-08-05 | `CHANGELOG_444_claude-baseline-store-boundary.md` | Extract Claude baseline files behind a Node store |
| 2026-08-05 | `CHANGELOG_443_codex-agents-store-boundary.md` | Extract Codex baseline files behind a Node store |
| 2026-08-05 | `CHANGELOG_442_grok-resource-store-boundary.md` | Extract Grok resource file ownership behind a Node store |
| 2026-08-05 | `CHANGELOG_441_application-resource-root-boundary.md` | Share one Node-hosted application resource root |
| 2026-08-05 | `CHANGELOG_440_codex-binary-host-boundary.md` | Resolve packaged Codex binaries outside Electron |
| 2026-08-05 | `CHANGELOG_439_grok-binary-cache-host-boundary.md` | Host the Grok executable cache outside Electron |
| 2026-08-05 | `CHANGELOG_438_application-path-host-boundary.md` | Install one immutable application host path identity |
| 2026-08-05 | `CHANGELOG_437_authoritative-database-host-boundary.md` | Inject the Core database host and prove its Node boundary |
| 2026-08-04 | `CHANGELOG_436_remote-core-cwd-free-console.md` | Add cwd-free session and opaque project contracts |
| 2026-08-04 | `CHANGELOG_435_remote-core-p2-host-controls.md` | Add bounded Feishu controls and exact Linux instance lifecycle |
| 2026-08-04 | `CHANGELOG_434_remote-core-p1-foundations.md` | Establish the three-topology remote Core P1 foundations |
| 2026-08-04 | `CHANGELOG_433_review-responsibility-and-depth.md` | Unify review roles and keep follow-up severity-driven |
| 2026-08-04 | `CHANGELOG_432_diff-history-and-runtime-diagnostics.md` | Keep diffs current and make runtime delays diagnosable |
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
