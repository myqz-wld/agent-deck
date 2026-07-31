# Recent Week Changelogs

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
