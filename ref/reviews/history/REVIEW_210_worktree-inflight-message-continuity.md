---
review_id: 210
reviewed_at: 2026-08-03
baseline_commit: 0ca1e61df3b196366ce0f771104b4f3f65da8f12
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record and bucket-index maintenance are mechanical archive work."
---

# REVIEW_210_worktree-inflight-message-continuity: Worktree transition message continuity

## Scope and method

A user report that `enter_worktree` and `exit_worktree` appeared to lose in-flight messages led to
a lifecycle audit from provider tool-start observation through transition buffering, runtime cwd
replacement, recovery, cleanup retry, and provider queue release. This was an implementation and
self-review pass; neither `simple-review` nor `deep-review` was invoked.

```review-scope
src/main/adapters/claude-code/sdk-bridge/__tests__/cwd-transition-controller.test.ts
src/main/adapters/claude-code/sdk-bridge/cwd-transition-controller.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/cwd-transition-controller.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/message-controller-handoff.test.ts
src/main/adapters/codex-cli/sdk-bridge/cwd-transition-controller.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/grok-build/__tests__/cwd-transition-controller.test.ts
src/main/adapters/grok-build/__tests__/message-controller.test.ts
src/main/adapters/grok-build/cwd-transition-controller.ts
src/main/adapters/grok-build/message-controller.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.handler.test.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts
src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts
src/main/session/worktree-transition/__tests__/coordinator-observe.test.ts
src/main/session/worktree-transition/__tests__/ingress-guard.test.ts
src/main/session/worktree-transition/__tests__/recovery.test.ts
src/main/session/worktree-transition/__tests__/tool-invocation-registry.test.ts
src/main/session/worktree-transition/__tests__/transition-delivery.test.ts
src/main/session/worktree-transition/coordinator.ts
src/main/session/worktree-transition/ingress-guard.ts
src/main/session/worktree-transition/recovery.ts
src/main/session/worktree-transition/tool-invocation-registry.ts
src/main/session/worktree-transition/transition-delivery.ts
src/main/session/worktree-transition/types.ts
src/main/store/__tests__/worktree-transition-lifecycle.test.ts
src/main/store/worktree-transition-drain-repo.ts
src/main/store/worktree-transition-input-repo.ts
src/main/store/worktree-transition-repo.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Transition delivery took one pending-input snapshot and then changed phase. An input appended after that snapshot but before phase settlement was acknowledged as buffered yet could remain orphaned until a later transition deleted or misdelivered it. | Add an atomic SQLite drain-and-seal operation. It changes phase and clears `tool_use_id` only when no undelivered input exists; delivery repeats whenever a concurrent append wins first. An append that loses to the seal falls through to the live post-switch adapter queue. |
| HIGH | Claude cwd replacement closed the old SDK runtime without migrating its already accepted `pendingUserMessages`, so messages queued before the durable transition record could disappear. | Snapshot pending message thunks and enqueue fingerprints before close, then append them behind the fixed continuation in both target-cwd and rollback replacement runtimes. |
| HIGH | Codex steer and Grok interjection requests could already be locally submitting when the transition gate armed, leaving their ownership attached to the old turn. | Cancel locally unaccepted submissions and requeue the exact message and deferred-event metadata ahead of ordinary queued work. Provider tool-start observation also forces new Codex/Grok ingress into queues during preflight, before the transition row exists. |
| MEDIUM | A `cleanup_pending` retry could begin after continuation acceptance but before buffered input delivery had reached a closed boundary. | Cleanup retry now requires both the durable input seal and release of the observed tool invocation. Failed cleanup keeps its lease while sealing ingress atomically. |

No confirmed finding remains open.

## Validation and evidence

- The Electron-ABI full suite passed 448 files and 3,670 tests; one credentialed live smoke test
  remained intentionally skipped.
- Focused worktree and adapter coverage passed 71 tests after the final type tightening. The SQLite
  transaction tests also passed in the Electron-ABI full suite.
- Node and renderer TypeScript checks passed, and the production main/preload/renderer build passed.
- `pnpm logger:check`, bundled Grok runtime verification, `git diff --check`, and the repository
  review-expiry inspection passed.
- All changed production files remain below the 500-line guardrail.

## Fixes landed

- Worktree input ingress now has a linearizable close boundary shared with phase settlement.
- Normal completion, preparation rollback, startup recovery, and failed-cleanup recovery all use
  the same repeat-until-sealed delivery path.
- Claude preserves pre-transition FIFO state across runtime recreation; Codex and Grok preserve
  locally unaccepted active-turn corrections when arming the transition.
- Messages arriving between provider tool-start and durable transition creation queue instead of
  steering or interjecting into the turn that is about to be interrupted.

## Residual risk

- No credentialed live Claude, Codex, or Grok transition was run. Deterministic adapter tests cover
  preflight queueing, local submission cancellation, runtime replacement, rollback, and FIFO order.
- The installed Agent Deck process that owns the active session also owns port 47821. It was not
  terminated to force a development restart because doing so would terminate this delivery session;
  the rebuilt main-process code takes effect on the next normal restart.
- A steer or interjection already acknowledged by the provider before local transition arming
  remains owned by that provider's native session history. The new requeue path intentionally
  applies only while local provider acceptance is still pending, avoiding known duplicate turns.

## Follow-up

After the rebuilt app restarts, smoke one enter and one exit per adapter while sending messages
during worktree preparation, immediately after the tool result, and during a forced cleanup retry.
Confirm that each message appears once and runs from the expected cwd.
