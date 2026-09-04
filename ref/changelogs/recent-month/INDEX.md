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
| 2026-08-27 | `CHANGELOG_634_system-status-session-readiness.md` | Align system status rows and stabilize Claude startup controls |
| 2026-08-27 | `CHANGELOG_633_codex-clear-stable-id-feedback.md` | Preserve Codex clear completion on same-id native rotation |
| 2026-08-27 | `CHANGELOG_632_session-command-system-feedback.md` | Show one final system status for silent native commands |
| 2026-08-27 | `CHANGELOG_631_adapter-session-commands.md` | Add native adapter slash commands to Local and Remote composers |
| 2026-08-24 | `CHANGELOG_630_session-authoring-interaction-stability.md` | Stabilize trust, History reactivation, and expanded composer actions |
| 2026-08-24 | `CHANGELOG_629_session-settings-clarity.md` | Clarify project trust, Hook actions, and Codex SessionEnd timeout |
| 2026-08-24 | `CHANGELOG_628_native-project-trust.md` | Add native project trust to Local and Remote session creation |
| 2026-08-23 | `CHANGELOG_627_grok-sandbox-next-turn.md` | Apply active-turn Grok sandbox choices before the next turn |
| 2026-08-23 | `CHANGELOG_626_new-session-sandbox-label.md` | Align sandbox field labels across new-session adapters |
| 2026-08-23 | `CHANGELOG_625_provider-runtime-app-sync.md` | Refresh embedded provider runtimes and install the macOS app |
| 2026-08-23 | `CHANGELOG_624_session-config-read-latency.md` | Keep adapter-default reads inside the 150 ms UI grace |
| 2026-08-21 | `CHANGELOG_623_global-async-navigation-readiness.md` | Apply the 150 ms rule across asynchronous navigation |
| 2026-08-20 | `CHANGELOG_622_global-stable-action-presentation.md` | Stabilize dynamic actions and 150 ms configuration visuals globally |
| 2026-08-20 | `CHANGELOG_621_stable-session-create-action.md` | Keep the create action visually and geometrically stable |
| 2026-08-20 | `CHANGELOG_620_atomic-session-configuration-readiness.md` | Keep adapter configuration switches visually atomic for 150 ms |
| 2026-08-19 | `CHANGELOG_619_provider-runtime-release-sync.md` | Sync embedded provider runtimes and local CLIs to stable releases |
| 2026-08-18 | `CHANGELOG_618_unified-browser-skill-cli-iab.md` | Unify Browser skill, CLI, responsive IAB, and annotation |
| 2026-08-17 | `CHANGELOG_617_next-turn-gateway-switching.md` | Apply choice-only Gateway changes from the next Codex turn |
| 2026-08-17 | `CHANGELOG_616_codex-gateway-toml-cutover.md` | Cut Codex selection over to complete Gateway TOML files |
| 2026-08-16 | `CHANGELOG_615_codex-gateway-capacity-profiles.md` | Add per-provider Codex context and compaction profiles |
| 2026-08-16 | `CHANGELOG_614_provider-runtime-app-refresh.md` | Refresh Claude and Grok runtimes and reinstall the macOS app |
| 2026-08-15 | `CHANGELOG_613_interruptible-reconnect-and-session-readiness.md` | Make Remote reconnect interruptible and finish 150 ms session readiness |
| 2026-08-14 | `CHANGELOG_612_feishu-server-one-click.md` | Add server-managed Feishu lifecycle for Relay and Full |
| 2026-08-13 | `CHANGELOG_611_feishu-p0-surface-cleanup.md` | Remove dormant Team and permission product surfaces |
| 2026-08-13 | `CHANGELOG_610_explicit-ssh-reconnect.md` | Rebuild an exhausted SSH connection on explicit Connect |
| 2026-08-13 | `CHANGELOG_609_remote-settings-local-controls.md` | Keep local controls editable and prevent generator text clipping |
| 2026-08-13 | `CHANGELOG_608_simplified-session-and-team-navigation.md` | Remove Permissions/Team pages and align Remote generator controls |
| 2026-08-13 | `CHANGELOG_607_remote-ui-runtime-convergence.md` | Reuse Local UI and restore Remote summaries/checkpoints |
| 2026-08-13 | `CHANGELOG_606_remote-settings-agent-runtime-sync.md` | Complete Remote settings and built-in Agent runtime parity |
| 2026-08-13 | `CHANGELOG_605_remote-settings-ui-parity.md` | Align Remote Settings groups and simplify read-only copy |
| 2026-08-13 | `CHANGELOG_604_deployment-config-home.md` | Standardize deployment config home and harden Worker restart |
| 2026-08-13 | `CHANGELOG_603_remote-live-create-parity.md` | Align Remote Live controls, session creation, and source form |
| 2026-08-13 | `CHANGELOG_602_remote-read-only-worker-assets.md` | Make Remote config read-only and sync Worker assets |
| 2026-08-12 | `CHANGELOG_601_remote-provider-selector-parity.md` | Align Remote provider selectors with Local |
| 2026-08-12 | `CHANGELOG_600_remote-history-actions-and-directory-create.md` | Align Remote session actions and Workspace creation |
| 2026-08-12 | `CHANGELOG_599_automatic-remote-provider-catalog.md` | Derive Remote provider choices without a manual catalog |
| 2026-08-12 | `CHANGELOG_598_ipc-readiness-state-machine.md` | Make 150 ms IPC readiness complete and identity-safe |
| 2026-08-12 | `CHANGELOG_597_remote-provider-readiness-and-history-parity.md` | Restore Remote quotas and align Local/Remote History |
| 2026-08-12 | `CHANGELOG_596_remote-source-flat-styling.md` | Simplify Remote source styling with flat neutral surfaces |
| 2026-08-12 | `CHANGELOG_595_remote-source-visual-refresh.md` | Refresh Remote source cards with glass styling |
| 2026-08-12 | `CHANGELOG_594_initial-readiness-and-permission-preload.md` | Delay fast async loading fallbacks until needed |
| 2026-08-12 | `CHANGELOG_593_new-session-defaults-and-tab-alignment.md` | Stabilize new-session defaults and compact UI alignment |
| 2026-08-12 | `CHANGELOG_592_remote-full-ui-parity.md` | Complete source-authoritative Remote UI parity |
| 2026-08-11 | `CHANGELOG_591_remote-transport-ui-convergence.md` | Stabilize Remote transport and align offline/list UI |
| 2026-08-11 | `CHANGELOG_590_remote-session-continuity.md` | Complete Remote continuity and active input |
| 2026-08-11 | `CHANGELOG_589_codex-never-approval-default.md` | Default Codex approvals to never |
| 2026-08-11 | `CHANGELOG_588_remote-worker-ui-authority.md` | Align Remote UI with Core and Worker authority |
| 2026-08-10 | `CHANGELOG_587_remote-token-usage-ingest.md` | Persist Remote token telemetry and recover keyed history |
| 2026-08-10 | `CHANGELOG_586_remote-source-auto-connect.md` | Restore the persisted active Remote connection |
| 2026-08-10 | `CHANGELOG_585_remote-full-page-parity.md` | Align Remote with the Local capability-backed workspace |
| 2026-08-10 | `CHANGELOG_584_linux-deployment-automation.md` | Add managed Relay, Worker, and Full deployment entrypoints |
| 2026-08-10 | `CHANGELOG_583_local-macos-install.md` | Automate rollback-safe local macOS installation |
| 2026-08-09 | `CHANGELOG_582_podman-health-json-argv.md` | Use executable-first Podman health argv |
| 2026-08-09 | `CHANGELOG_581_relay-image-exact-node-runtime.md` | Provision the exact Relay Node runtime in the image |
| 2026-08-09 | `CHANGELOG_580_relay-health-startup-gate.md` | Gate Relay systemd activation on container health |
| 2026-08-09 | `CHANGELOG_579_provider-runtime-dependencies.md` | Refresh packaged Claude, Codex, and Grok runtime dependencies |
| 2026-08-09 | `CHANGELOG_578_remote-parity-finalization.md` | Close handoff, native-fork, and Remote intent residuals |
| 2026-08-08 | `CHANGELOG_569_workspace-bounded-provider-sandboxes.md` | Compile Remote provider sandboxes under the Workspace ceiling |
| 2026-08-08 | `CHANGELOG_436_handoff-lifecycle-context-v2.md` | Harden handoff context, ownership, and large-capture handling |
| 2026-08-07 | `CHANGELOG_577_remote-core-user-presentations.md` | Reuse Local plan and diff gates for Remote sessions |
| 2026-08-07 | `CHANGELOG_576_remote-desktop-browser-broker.md` | Broker Remote Browser tools through the connected desktop |
| 2026-08-07 | `CHANGELOG_575_remote-core-worktree-lifecycle.md` | Restore automatic Remote worktree cwd transitions |
| 2026-08-07 | `CHANGELOG_574_remote-image-asset-broker.md` | Display Remote image diffs through an opaque Core asset broker |
| 2026-08-07 | `CHANGELOG_573_remote-core-session-collaboration-mcp.md` | Add Core-owned Remote session collaboration MCP tools |
| 2026-08-07 | `CHANGELOG_572_remote-issues-parity.md` | Reuse the shared Issues board through Remote Core |
| 2026-08-07 | `CHANGELOG_571_remote-task-and-activity-parity.md` | Reuse shared Remote task and activity presentations |
| 2026-08-07 | `CHANGELOG_570_remote-summary-and-text-diff-parity.md` | Add Workspace-bounded Remote summaries and text diffs |
| 2026-08-07 | `CHANGELOG_568_remote-new-session-parity.md` | Mirror Local New Session controls through Remote Core |
| 2026-08-06 | `CHANGELOG_565_workspace-bounded-relay-worker.md` | Bound Relay Worker clients to one Workspace |
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
