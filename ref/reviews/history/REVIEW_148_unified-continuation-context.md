---
review_id: 148
reviewed_at: 2026-07-11
baseline_commit: 92382b43aae51875531c7f56a08550acdc9dad9e
expired: false
skipped_expired: []
---

# REVIEW_148_unified-continuation-context: Unified Continuation Context implementation review

## Scope

The reviewer inspected the complete post-baseline staged implementation for the provider-neutral
Continuation Context engine, including persistence/migrations, immutable capture, folding and
projection, provider isolation, trusted initial turns, UI/MCP handoff orchestration, missing-history
recovery, compatibility cleanup, prompt assets, settings, tests, and records.

```review-scope
.prompt-asset-improver/inventory.json
README.md
ref/changelogs/recent-3-days/CHANGELOG_358_unified-continuation-context.md
ref/changelogs/recent-3-days/INDEX.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-failure-cleanup.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-fork-rename.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts
src/main/adapters/claude-code/sdk-bridge/constants.ts
src/main/adapters/claude-code/sdk-bridge/create-session/_deps.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts
src/main/adapters/claude-code/sdk-bridge/recoverer-messages.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/_deps.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/recovery-waiter.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller-types.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize.ts
src/main/adapters/claude-code/sdk-bridge/session-lifecycle.ts
src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/codex-instance-pool.ts
src/main/adapters/codex-cli/handoff-runner.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-new.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-validation.test.ts
src/main/adapters/codex-cli/sdk-bridge/client-registry.ts
src/main/adapters/codex-cli/sdk-bridge/codex-jsonl-fallback.ts
src/main/adapters/codex-cli/sdk-bridge/codex-recoverer-messages.ts
src/main/adapters/codex-cli/sdk-bridge/constants.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-new.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-resume.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-validate.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/thread-options-builder.ts
src/main/adapters/codex-cli/summarizer-runner.ts
src/main/adapters/deepseek-claude-code/__tests__/summarise-events.test.ts
src/main/adapters/deepseek-claude-code/index.ts
src/main/adapters/shared/recovery-cancelled.ts
src/main/adapters/types/agent-adapter.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.cutover.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.preflight.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/_deps.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/event-bus.ts
src/main/index/__tests__/_deps.test.ts
src/main/index/_deps.ts
src/main/index/bootstrap-wiring.ts
src/main/index/lifecycle-hooks.ts
src/main/ipc/__tests__/issues.test.ts
src/main/ipc/__tests__/session-hand-off-finalize.test.ts
src/main/ipc/__tests__/session-hand-off-response.test.ts
src/main/ipc/__tests__/sessions-hand-off-options.test.ts
src/main/ipc/__tests__/sessions.test.ts
src/main/ipc/__tests__/settings-continuation.test.ts
src/main/ipc/adapters.ts
src/main/ipc/issues.ts
src/main/ipc/session-hand-off-finalize.ts
src/main/ipc/session-hand-off-response.ts
src/main/ipc/session-hand-off.ts
src/main/ipc/sessions-hand-off-helper.ts
src/main/ipc/sessions.ts
src/main/ipc/settings.ts
src/main/session/__tests__/hand-off.test.ts
src/main/session/__tests__/summarizer-runner.test.ts
src/main/session/continuation-context/__tests__/budget-policy.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold.test.ts
src/main/session/continuation-context/__tests__/checkpoint-generator.test.ts
src/main/session/continuation-context/__tests__/checkpoint-projection.test.ts
src/main/session/continuation-context/__tests__/checkpoint-schema.test.ts
src/main/session/continuation-context/__tests__/codex-isolation.test.ts
src/main/session/continuation-context/__tests__/event-normalizer.test.ts
src/main/session/continuation-context/__tests__/fresh-session-executor.test.ts
src/main/session/continuation-context/__tests__/handoff.test.ts
src/main/session/continuation-context/__tests__/initial-turn.test.ts
src/main/session/continuation-context/__tests__/message-classifier.test.ts
src/main/session/continuation-context/__tests__/preparation-cache.test.ts
src/main/session/continuation-context/__tests__/public-spoof.test.ts
src/main/session/continuation-context/__tests__/raw-user-tail.test.ts
src/main/session/continuation-context/__tests__/recovery.test.ts
src/main/session/continuation-context/__tests__/renderer.test.ts
src/main/session/continuation-context/__tests__/runtime.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/__tests__/source-spool.test.ts
src/main/session/continuation-context/__tests__/token-estimator.test.ts
src/main/session/continuation-context/budget-policy.ts
src/main/session/continuation-context/checkpoint-fold-chunk.ts
src/main/session/continuation-context/checkpoint-fold-coverage-gap.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-generator.ts
src/main/session/continuation-context/checkpoint-projection.ts
src/main/session/continuation-context/checkpoint-prompts.ts
src/main/session/continuation-context/checkpoint-schema.ts
src/main/session/continuation-context/codex-isolation.ts
src/main/session/continuation-context/context-capacity-resolver.ts
src/main/session/continuation-context/event-normalizer.ts
src/main/session/continuation-context/fresh-session-executor.ts
src/main/session/continuation-context/handoff.ts
src/main/session/continuation-context/initial-turn.ts
src/main/session/continuation-context/message-classifier.ts
src/main/session/continuation-context/preparation-cache.ts
src/main/session/continuation-context/raw-user-tail.ts
src/main/session/continuation-context/recovery.ts
src/main/session/continuation-context/renderer.ts
src/main/session/continuation-context/resolver.ts
src/main/session/continuation-context/runtime-fingerprint.ts
src/main/session/continuation-context/runtime.ts
src/main/session/continuation-context/service.ts
src/main/session/continuation-context/singleflight.ts
src/main/session/continuation-context/source-spool.ts
src/main/session/continuation-context/token-estimator.ts
src/main/session/continuation-context/types.ts
src/main/session/hand-off/__tests__/context-prompt.test.ts
src/main/session/hand-off/__tests__/executor.test.ts
src/main/session/hand-off/__tests__/target-resolver.test.ts
src/main/session/hand-off/__tests__/ui-coordinator.test.ts
src/main/session/hand-off/context-prompt.ts
src/main/session/hand-off/cutover-coordinator.ts
src/main/session/hand-off/executor.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/hand-off/ui-coordinator.ts
src/main/session/manager/_deps.ts
src/main/session/oneshot-llm/__tests__/build-prompt.test.ts
src/main/session/oneshot-llm/build-prompt.ts
src/main/session/oneshot-llm/claude-runner.ts
src/main/session/oneshot-llm/clean-result.ts
src/main/session/oneshot-llm/codex-runner.ts
src/main/session/oneshot-llm/index.ts
src/main/session/resume-history/__tests__/inject-history.test.ts
src/main/session/resume-history/index.ts
src/main/session/resume-history/inject-history.ts
src/main/session/summarizer/index.ts
src/main/session/summarizer/llm-runners.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/continuation-checkpoint-repo.test.ts
src/main/store/__tests__/event-repo-recent-messages.test.ts
src/main/store/__tests__/event-revision-repo.test.ts
src/main/store/__tests__/repo-tiebreaker.test.ts
src/main/store/__tests__/session-event-revision-rename.test.ts
src/main/store/__tests__/settings-store-codex-reasoning.test.ts
src/main/store/__tests__/settings-store-continuation.test.ts
src/main/store/__tests__/settings-store.test.ts
src/main/store/__tests__/v037-migration.test.ts
src/main/store/__tests__/v038-migration.test.ts
src/main/store/continuation-checkpoint-repo.ts
src/main/store/event-repo.ts
src/main/store/event-revision-repo.ts
src/main/store/message-delivery-state.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v037_event_revisions.sql
src/main/store/migrations/v038_continuation_checkpoints.sql
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/__tests__/archive.test.ts
src/main/store/session-repo/archive.ts
src/main/store/session-repo/index.ts
src/main/store/session-repo/rename.ts
src/main/store/settings-store.ts
src/preload/api/sessions.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/settings/ProviderModelThinkingFields.tsx
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/ExperimentalSection.tsx
src/renderer/components/settings/sections/LifecycleSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/shared/ipc-channels.ts
src/shared/message-limits.ts
src/shared/types/session.ts
src/shared/types/settings.ts
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
```

## Review Mode and User Override

The planned heterogeneous Claude + Codex deep-review was started, then explicitly stopped by the
user. The user requested one independent Codex reviewer using `gpt-5.6-sol` with `xhigh`
thinking and no Claude reviewer. This record therefore reports the actual single-review gate and
must not be represented as a completed heterogeneous deep-review.

Reviewer session: `019f501e-c693-7903-abf0-81df104a1134` (closed after approval).

## Method

- Read the durable approved plan and frozen baseline manifest.
- Re-scanned the complete staged diff from baseline `92382b43aae51875531c7f56a08550acdc9dad9e`
  on every round.
- Traced revision/CAS/rebuild boundaries, TEMP pre-await capture, checkpoint fold/projection,
  compactor isolation, private trusted turns, UI/MCP cutover, target freezing, and provider recovery.
- Required concrete race traces and focused regressions for every CRITICAL/HIGH/material MEDIUM
  finding.
- Re-reviewed the repaired implementation until no material finding remained.

## Gate Result

APPROVE under the user's explicit single-reviewer override.

Severity distribution across all rounds:

- CRITICAL: 0
- HIGH: 4 fixed
- MEDIUM: 4 fixed
- Remaining CRITICAL/HIGH/material MEDIUM: 0

## Findings and Resolutions

### HIGH fixed: concurrent handoffs could create duplicate successors and resource owners

UI and MCP now share one token-safe, process-wide per-source cutover lease. MCP holds it before paid
preparation through spool cleanup; UI holds it for commit/finalization. Parallel attempts cannot
create a second successor or copy the same ownership marker.

### HIGH fixed: a near-cap checkpoint and boundary event could wedge revision progress

Oversized revision groups now deduplicate a single retained edge, bound edge payload, and search a
whole-fact fold-only projection using the actual system+prompt token estimate. All active/blocked
facts across every section are mandatory; only inactive facts may be pruned.

### HIGH fixed: source state could drift while successor creation awaited

The shared executor carries lifecycle/revision/rebuild/runtime preconditions and revalidates after
successor creation immediately before synchronous ownership transfer. Drift closes the orphan and
leaves resources/source finalization untouched. MCP also matches spool runtime/lineage and
re-resolves inherited target options from the current source row.

### HIGH fixed: the first cannot-fit fallback claimed false coverage

The unchanged-checkpoint revision advance was removed. The engine now persists an app-owned blocked
coverage-gap marker containing a full length-framed raw-group SHA-256, exact revision/event bounds,
and current-group evidence while retaining every active/blocked fact. Provider output cannot add,
remove, move, resolve, or rewrite reserved markers, and target projection prioritizes them. Future
preparations remain `coverage-gap`. If even the marker cannot fit without active-fact loss, no CAS
occurs: the prior revision and exact uncovered interval remain intact.

### MEDIUM fixed: singleflight merged incompatible operational limits

The key includes purpose, effective fold budget, deadline, and fold/repair call caps. Caller-owned
AbortSignals bypass shared work. Both handoff/recovery start orders and signal isolation are covered.

### MEDIUM fixed: source-finalization warnings disappeared in the renderer

UI consumes the success-with-warning result and retains a visible warning. Main requests successor
focus only when source finalization succeeds.

### MEDIUM fixed: UI lost orphan successor identity when cleanup failed

Known post-create execution failures cross Electron IPC as a serializable discriminated result with
stage, stable successor ID, and cleanup status. The renderer shows a persistent zh-CN warning and
does not render the internal English diagnostic.

### MEDIUM fixed: closing/reopening bypassed the orphan retry interlock

Cleanup-failed acknowledgements are stored outside modal state and keyed by source session. Close,
session navigation, and return restore the same ID/warning and disabled Generate state. Only the
explicit user acknowledgement deletes the record and re-enables preparation.

## Final Reviewer Verification

- Final disposition: **APPROVE**, with no CRITICAL, HIGH, or material MEDIUM findings.
- The reviewer revalidated bounded marker hash/evidence/range/CAS/future-fold/projection semantics,
  shared UI/MCP cutover exclusion, target freezing, private trusted turns, legacy classification,
  fail-closed compactor behavior, and Claude/Codex recovery cleanup.
- Final interlock trace proved source A failure → close → source B → return to A → restored orphan ID
  and disabled retry → explicit acknowledgement → retry enabled.
- Reviewer-focused validation passed, including 12 continuation/cutover files and the final
  4-file/35-test IPC/executor/UI gate; typecheck, logger, staged/unstaged diff checks passed.
- No files were edited by the reviewer.

## Lead Validation Before Final Delivery

- Final full suite: 245 files / 2,390 tests passed.
- Post-fix integrated gate: 12 files / 81 tests passed.
- Focused v037/v038 migration, 100,000-row revision paging/query-plan, rename, and checkpoint
  repository gate: 5 files / 27 tests passed.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, staged/unstaged diff checks, and
  `scripts/file-level-review-expiry.sh` passed after final reviewer approval.
- All changed production files are at most 500 lines.
- The running Agent Deck application was not restarted because it owns active sessions.

## Residual Risk

- The user explicitly replaced the planned heterogeneous review with one Codex reviewer; provider
  diversity was therefore not exercised in the final review gate.
- Codex checkpoint generation remains deliberately fail-closed until the installed app-server can
  prove the final model-visible registry has no side-effecting tools.
- Interactive main/preload verification requires a later safe app restart; source validation does
  not overwrite or restart the active installed application.

## Related Records

- [CHANGELOG_358](../../changelogs/recent-month/CHANGELOG_358_unified-continuation-context.md)
- [Durable plan](../../plans/recent-month/PLAN_5_unified-continuation-context.md)
