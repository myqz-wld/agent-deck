---
review_id: 165
reviewed_at: 2026-07-21
baseline_commit: d9fc8e1d4c7adef93bef2f78b1faf03b94f4567a
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Lifecycle-record rebucketing and index maintenance are mechanical archive work."
---

# REVIEW_165_plan-review-message-consumption: Review isolation and message consumption boundaries

## Scope and method

At the user's explicit request, the current Codex lead performed this audit alone; Claude and
DeepSeek reviewer sessions were not used. The audit traced persistence and History visibility,
lazy review-child allocation, one-shot evidence construction, both provider queue lifecycles,
attachment ownership, IPC/renderer refreshes, hand-off boundaries, and expanded-composer focus and
send behavior. It combined diff inspection, targeted race regressions, and the full repository
suite.

```review-scope
README.md
src/main/__tests__/_shared/mocks/session-repo.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.message-controller.test.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/stream-processor-retirement.test.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/pending-outgoing.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/message-controller-handoff.test.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-new.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/deepseek-claude-code/index.ts
src/main/adapters/types.ts
src/main/adapters/types/agent-adapter.ts
src/main/adapters/types/create-session-opts.ts
src/main/agent-deck-mcp/__tests__/spawn-fork-handler.test.ts
src/main/agent-deck-mcp/tools/handlers/spawn-handler-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/ipc/__tests__/adapters-message-dispatch.test.ts
src/main/ipc/__tests__/adapters-outgoing.test.ts
src/main/ipc/adapters-message-dispatch.ts
src/main/ipc/adapters-outgoing.ts
src/main/ipc/adapters.ts
src/main/plan-review/__tests__/deep-review-session.test.ts
src/main/plan-review/__tests__/feedback-synthesis.test.ts
src/main/plan-review/__tests__/service-no-dialogue.test.ts
src/main/plan-review/__tests__/service.test.ts
src/main/plan-review/deep-review-session.ts
src/main/plan-review/feedback-synthesis.ts
src/main/plan-review/prompts.ts
src/main/plan-review/service.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/__tests__/manager-test-setup.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/session/manager/_deps.ts
src/main/session/manager/session-registration.ts
src/main/session/oneshot-llm/__tests__/race-with-timeout.test.ts
src/main/session/oneshot-llm/claude-runner.ts
src/main/session/oneshot-llm/codex-runner.ts
src/main/session/oneshot-llm/race-with-timeout.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/v044-migration.test.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v044_sessions_hidden_from_history.sql
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/__tests__/history-visibility.test.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/history.ts
src/main/store/session-repo/index.ts
src/main/store/session-repo/rename.ts
src/main/store/session-repo/types.ts
src/main/store/session-repo/visibility.ts
src/preload/api/adapters.ts
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/ComposerInput.tsx
src/renderer/components/SessionDetail/composer-sdk/ExpandedComposerOverlay.tsx
src/renderer/components/SessionDetail/composer-sdk/PendingOutgoingQueue.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.test.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/pending-rows/PlanReviewConversation.tsx
src/shared/ipc-channels.ts
src/shared/types/agent.ts
src/shared/types/permission.ts
src/shared/types/session.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Claude removed a deferred queued item before asynchronous attachment materialization completed. A concurrent delete could therefore lose ownership of the race and still allow stale delivery or an untracked failure. | Keep the thunk in the authoritative queue throughout materialization, block a failed item at the queue head with an exposed error, and yield only if the item still exists after the read. Add delete-during-read and materialization-failure regressions. |
| MEDIUM | Pending deletion performed attachment cleanup before returning success, so a cleanup failure could report deletion failure after the authoritative queue item was already gone and encourage a misleading retry. | Settle cleanup independently with `Promise.allSettled`, retain successful queue deletion, and log cleanup failures without restoring the item. |
| MEDIUM | `raceWithTimeout` had an abort gap between its initial signal check and listener registration, allowing a narrowly timed cancellation to be missed. | Register the listener, recheck the signal, deduplicate the abort handler, and cover an abort injected immediately before listener registration. |
| MEDIUM | The expanded editor had dialog semantics but did not isolate background focus or trap Tab navigation, so keyboard users could leave the modal surface. | Mark background siblings inert and `aria-hidden`, trap forward/reverse Tab, close on Escape, and restore the prior focus target. |
| LOW | The Claude stream processor grew beyond the repository's 500-line source limit while absorbing queue behavior. | Extract message creation/consumption into `user-message-stream.ts`; the processor is now 495 lines. |

## Validation evidence

- `pnpm typecheck` passed.
- `pnpm test` passed 324 files and 2,925 tests; one opt-in credentialed Codex live smoke remained
  skipped as it is in the default repository suite.
- `pnpm build` and `pnpm logger:check` passed.
- Focused plan-review/one-shot suites passed 37 tests; focused queue/Claude suites passed 15 tests;
  race/Claude suites passed 23 tests; composer renderer coverage passed 13 tests. Each focused run
  was paired with type checking during implementation.
- The hidden-session migration, all History query modes, lazy first-question start, no-dialogue
  provider bypass, post-fork transcript bounds, Codex steering, deletion races, attachment cleanup,
  IME behavior, modal focus, and shared draft are covered by regressions.

## Residual risk and boundaries

- The ordinary waiting queue covers only messages still owned by a live adapter provider queue.
  Hand-off ingress remains a separate durable cutover transaction that persists and transfers input;
  folding it into this ephemeral queue would weaken its replay guarantee.
- Feedback synthesis is isolated and tool-free, but live credentialed providers are not invoked by
  the default automated suite. Runner arguments, adapter matching, temporary cwd isolation, and
  cancellation are covered with test doubles.
- Internal review sessions remain accessible to the active dialog and runtime lookup by design;
  the persisted visibility flag removes them only from History surfaces.
- Main/preload changes require a later application restart. Restart was explicitly deferred by the
  user, and no development or installed application process was started after validation.

## Follow-ups

No unresolved material finding remains.
