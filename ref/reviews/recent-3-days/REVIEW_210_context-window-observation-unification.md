---
review_id: 210
reviewed_at: 2026-08-03
baseline_commit: 027fa817e32ab72faddb878bcf1d9b8bb506e9c3
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, review, changelog, rebucketing, and index maintenance are mechanical records."
---

# REVIEW_210_context-window-observation-unification: Deep review of observed continuation capacity

## Scope and method

This record closes the iterative `deep-review` of the provider-neutral context-window observation
and trusted-continuation implementation from baseline `027fa817` through reviewed implementation
HEAD `fce0f761`. The confirmed heterogeneous pair was `reviewer-claude` (`claude-code`) and
`reviewer-codex` (`codex-cli`). Broad scope was partitioned into paired CORE, ADAPTERS, and
SURFACES batches, followed by paired end-to-end INTEGRATION rounds after primary convergence.

Every batch required complete readable scope, explicit restrictions, focused validation, stable
finding ids, and dependency traces across provider evidence, persistence, frozen sizing, candidate
acceptance/rollback, ownership transfer, IPC/MCP serialization, cache behavior, and renderer copy.
Routine findings were fixed and re-reviewed autonomously; no architecture-level decision was
required after the approved plan.

```review-scope
src/main/__tests__/_shared/mocks/session-repo.ts
src/main/adapters/__tests__/trusted-continuation.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-fork-rename.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/trusted-continuation-observer.test.ts
src/main/adapters/claude-code/sdk-bridge/context-usage.ts
src/main/adapters/claude-code/sdk-bridge/create-session/_deps.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/result-outcome.ts
src/main/adapters/claude-code/sdk-bridge/runtime-metadata-sync.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/trusted-continuation-observer.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
src/main/adapters/codex-cli/app-server/client.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.test.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.ts
src/main/adapters/codex-cli/app-server/notification-helpers.test.ts
src/main/adapters/codex-cli/app-server/notification-helpers.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/runtime-identity.test.ts
src/main/adapters/codex-cli/app-server/runtime-identity.ts
src/main/adapters/codex-cli/app-server/thread-mode.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/app-server/token-usage-translate.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/app-server/turn-output.test.ts
src/main/adapters/codex-cli/app-server/turn-output.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-retirement.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-observer.test.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-resume.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.test.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/trusted-continuation-observer.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/grok-build/__tests__/bridge-strict-startup-cleanup.test.ts
src/main/adapters/grok-build/__tests__/first-model-event-watchdog.test.ts
src/main/adapters/grok-build/__tests__/native-error.test.ts
src/main/adapters/grok-build/__tests__/runtime-identity.test.ts
src/main/adapters/grok-build/__tests__/runtime-lifecycle-coordinator.test.ts
src/main/adapters/grok-build/__tests__/runtime-mutation-controller.test.ts
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/grok-build/__tests__/sandbox-restart-controller.test.ts
src/main/adapters/grok-build/__tests__/session-setup.test.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/adapters/grok-build/__tests__/transport-recovery.test.ts
src/main/adapters/grok-build/__tests__/trusted-continuation-observer.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/first-model-event-watchdog.ts
src/main/adapters/grok-build/index.ts
src/main/adapters/grok-build/native-error.ts
src/main/adapters/grok-build/protocol-utils.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/runtime-identity.ts
src/main/adapters/grok-build/runtime-lifecycle-coordinator.ts
src/main/adapters/grok-build/runtime-mutation-controller.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/startup-registration-cleanup.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/trusted-continuation-observer.ts
src/main/adapters/grok-build/turn-queue-types.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/turn-response.ts
src/main/adapters/trusted-continuation.ts
src/main/adapters/types.ts
src/main/adapters/types/agent-adapter.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.cutover.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/_deps.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/result-projection.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-change-copy.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/ipc/__tests__/session-hand-off-input.test.ts
src/main/ipc/__tests__/session-hand-off-response.test.ts
src/main/ipc/session-hand-off-input.ts
src/main/ipc/session-hand-off-response.ts
src/main/ipc/session-hand-off.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/context-window/__tests__/identity.test.ts
src/main/session/context-window/__tests__/policy.test.ts
src/main/session/context-window/identity.ts
src/main/session/context-window/ingest.ts
src/main/session/context-window/policy.ts
src/main/session/context-window/service.ts
src/main/session/continuation-context/__tests__/budget-policy.test.ts
src/main/session/continuation-context/__tests__/capacity-fixtures.ts
src/main/session/continuation-context/__tests__/checkpoint-background-refresh.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-overflow.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold.test.ts
src/main/session/continuation-context/__tests__/codex-isolation.test.ts
src/main/session/continuation-context/__tests__/codex-live-smoke.test.ts
src/main/session/continuation-context/__tests__/fresh-session-executor.test.ts
src/main/session/continuation-context/__tests__/handoff.test.ts
src/main/session/continuation-context/__tests__/preparation-cache.test.ts
src/main/session/continuation-context/__tests__/public-spoof.test.ts
src/main/session/continuation-context/__tests__/recovery.test.ts
src/main/session/continuation-context/__tests__/resolver.test.ts
src/main/session/continuation-context/__tests__/runtime.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/budget-policy.ts
src/main/session/continuation-context/checkpoint-background-refresh.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-generator.ts
src/main/session/continuation-context/context-capacity-resolver.ts
src/main/session/continuation-context/fresh-session-executor.ts
src/main/session/continuation-context/generator-capacity-observation.ts
src/main/session/continuation-context/handoff.ts
src/main/session/continuation-context/preparation-cache.ts
src/main/session/continuation-context/preparation-renderer.ts
src/main/session/continuation-context/recovery.ts
src/main/session/continuation-context/resolver.ts
src/main/session/continuation-context/runtime.ts
src/main/session/continuation-context/service.ts
src/main/session/continuation-context/types.ts
src/main/session/hand-off/__tests__/executor.test.ts
src/main/session/hand-off/__tests__/target-resolver.test.ts
src/main/session/hand-off/__tests__/trusted-continuation-gate.entry-expiry.test.ts
src/main/session/hand-off/__tests__/trusted-continuation-gate.startup-failure.test.ts
src/main/session/hand-off/__tests__/trusted-continuation-gate.test.ts
src/main/session/hand-off/__tests__/ui-coordinator.test.ts
src/main/session/hand-off/executor.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/hand-off/trusted-continuation-gate.ts
src/main/session/hand-off/ui-coordinator.ts
src/main/session/hand-off/ui-preparation-view.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/store/__tests__/context-window-observation-repo.test.ts
src/main/store/__tests__/db-schema.test.ts
src/main/store/context-window-observation-repo.ts
src/main/store/schema.sql
src/main/store/schema.ts
src/main/store/session-repo/__tests__/context-usage.test.ts
src/main/store/session-repo/context-usage.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/rename.ts
src/main/store/session-repo/types.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionContextUsageChip.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/SessionContextUsageChip.test.tsx
src/renderer/components/__tests__/SessionList.test.tsx
src/renderer/components/hand-off/labels.ts
src/shared/types.ts
src/shared/types/context-window.ts
src/shared/types/session.ts
```

## Review trajectory

| Batch | Converged at | Outcome |
|---|---|---|
| ADAPTERS | `38115ea7` | Exact Claude/Codex/Grok attribution and readiness semantics closed; no material finding remained. |
| SURFACES | `204a5022` | Nullable-id, cleanup, retry, copy, acknowledgement, and cache terminality routes converged. |
| CORE | `13a03dfe` | Deadline, promise-ordering, rollback, and entry-expiry state matrices converged. |
| INTEGRATION | `fce0f761` | All cross-boundary identity, persistence, startup, and public-projection findings closed. |

## Material finding disposition

- Exact identity: removed Claude pricing-canonical selection authority; aligned Codex capacity
  fingerprints with reproducible target configuration; bounded serialized keys before persistence;
  and invalidated ambiguous shared-client Codex reroutes instead of relabeling another turn.
- Identity races: added revision dominance so asynchronous settings success/failure cannot restore
  evidence superseded by a reroute or authoritative boundary, and cleared accumulated turn capacity
  whenever later events become unattributed or change exact identity.
- Startup lifecycle: removed or closed failed new Grok strict-startup registrations and normalized
  all trusted primary/retry pre-stable-id failures into fixed safe main-process classifications.
- Deadline lifecycle: replaced wall-clock accounting with one monotonic budget, post-validated work
  settlement, distinguished rejected from unresolved startup at and after entry expiry, and retained
  exactly-once cleanup for candidates that can still materialize.
- Public consistency: preserved nullable successor ids, cleanup/retry attribution, terminal
  preparation eviction, one same-snapshot pre-spawn retry only, state-neutral copy, and raw-error
  containment across executor, MCP, IPC, renderer, and cache boundaries.

All confirmed CRITICAL, HIGH, MEDIUM, and LOW correctness findings are closed. The final Integration
round independently reconstructed the last two stale-identity counterexamples and both reviewers
reported zero new findings with Coverage COMPLETE.

## Validation and evidence

- Full Electron-ABI suite: 462 files / 3,814 tests passed; one explicit live-provider smoke skipped.
- Final focused identity/evidence validation: 4 files / 45 tests passed; reviewer-focused suites and
  isolated real-module probes independently exercised notification ordering and evidence lifetime.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, `git diff --check`, review-expiry inventory,
  legacy-consumer searches, and production-file-size gates passed.
- The production build started under a fresh Electron profile with schema v62, mounted MCP, listened
  on 127.0.0.1:47822, returned the expected unauthenticated 401 from `/mcp`, and shut down cleanly.
  The active Agent Deck host on 47821 was not stopped or modified.
- Final reviewer messages: Claude `4f056d72-9012-4990-8e6f-31e2893726b6`; Codex
  `8a12bd74-8c36-40d9-a514-0c78272724a2`.

## Accepted bounded residuals

- Alias/default generator configurations remain conservatively unknown until an exact runtime
  identity can be reproduced; this reduces capacity reuse rather than creating unsafe capacity.
- The renderer's stale-snapshot defense remains adapter-bound because the full trusted runtime key
  is intentionally not projected to public state.
- A successful lower-budget retry is visible in the result contract but has no durable toast after
  focus moves to the successor; this is a bounded product-feedback gap, not an ownership defect.
- The monotonic readiness budget pauses across system suspend. This avoids wall-clock rollback
  extension and does not weaken provider activity safety while the process is asleep.
- Native provider occurrence frequency was not live-captured. Adapter payload shapes and all
  relevant orderings were verified through bundled protocol evidence, repository fixtures, focused
  execution, and real production modules.

## Final verdict

ACCEPT. The implementation matches the approved design, the complete heterogeneous review has
converged, no material finding remains open, and no migration compatibility, static catalog, manual
override, paid probe, transcript estimate, or public trusted-capacity input was introduced.

## Related records

- `CHANGELOG_428_context-window-observation-unification.md`
- `PLAN_30_context-window-observation-unification.md`
