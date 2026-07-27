# Recent 3 Days Changelogs

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
| 2026-07-23 | `CHANGELOG_383_grok-build-adapter-profiles.md` | Add Grok Build ACP and adapter-specific runtime profiles |
| 2026-07-23 | `CHANGELOG_382_plan-review-feedback-discard-confirmation.md` | Confirm before approval discards plan-review feedback |
