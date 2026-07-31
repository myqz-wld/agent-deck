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
| 2026-07-11 | `CHANGELOG_361_storage-performance-observability-svg-icons.md` | Stage storage maintenance, require MCP readiness, and unify SVG icons |
| 2026-07-11 | `CHANGELOG_360_periodic-summary-evidence.md` | Make periodic summaries evidence-rich and revision-safe |
| 2026-07-11 | `CHANGELOG_359_session-pinning-reviewer-model.md` | Add persistent Live pins and update the Codex reviewer model |
| 2026-07-11 | `CHANGELOG_358_unified-continuation-context.md` | Unify provider-neutral Continuation Context across hand-off and recovery |
| 2026-07-10 | `CHANGELOG_357_session-runtime-and-compact-handoff.md` | Add per-session model controls and compact cross-adapter hand-off |
| 2026-07-10 | `CHANGELOG_356_codex-max-thinking.md` | Restore Codex MAX across settings and existing thinking inputs |
| 2026-07-10 | `CHANGELOG_355_filter-desktop-ephemeral-codex-hooks.md` | Hide Desktop ambient Codex hooks from external sessions |
| 2026-07-10 | `CHANGELOG_354_thinking-options-and-claude-usage.md` | Refine thinking options and collect Claude reasoning usage |
| 2026-07-09 | `CHANGELOG_353_spawn-session-native-fork.md` | Add provider-native parallel session forks |
| 2026-07-09 | `CHANGELOG_352_remove-fable-5-suggestion.md` | Remove redundant fable-5 suggestion |
| 2026-07-09 | `CHANGELOG_351_mcp-prompt-contracts.md` | Make MCP contracts explicit and self-correcting |
| 2026-07-09 | `CHANGELOG_350_codex-collaboration-observability.md` | Complete Codex collaboration activity |
| 2026-07-09 | `CHANGELOG_349_project-engineering-foundation.md` | Align repository engineering foundation |
