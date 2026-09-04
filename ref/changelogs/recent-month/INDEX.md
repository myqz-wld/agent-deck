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
