---
review_id: 189
reviewed_at: 2026-07-29
baseline_commit: e28f25b424d8bbd29b8a132bc560ddf8c9b014f6
expired: false
---

# REVIEW_189_grok-pending-chat-duplication: Deferred-only pending messages

## Scope

Investigate and fix the Grok Build new-session regression where the first user message appeared
both in chat and in the provider-acceptance queue.

```review-scope
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/turn-queue-helpers.ts
src/main/adapters/grok-build/turn-queue.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Grok converted every queued or submitting input into a renderer `PendingAgentMessage`, including uncorrelated inputs whose user event had already been emitted. A new session therefore rendered its first prompt in chat immediately while startup still left the same prompt in the waiting queue. The exposed internal ID also allowed cancellation after the chat message was already durable. | Match the shared adapter contract and the Claude/Codex implementations: expose and remove only inputs explicitly deferred to the provider-acceptance boundary and carrying a renderer correlation ID. Keep already-rendered uncorrelated inputs in the provider's internal queue without presenting them as cancellable pending rows. |

## Evidence

- The reported new-session path calls Grok initial enqueue without deferred metadata. That path emits
  the user event immediately, while background ACP startup can leave the same message in
  `runtime.queue`.
- `PendingAgentMessage.id` is documented as present only for explicitly deferred user events.
  Claude and Codex both drop entries without `turnCorrelationId`; Grok previously synthesized an
  ID from its private queue message instead.
- The regression test holds the runtime before startup, proves that the initial prompt is already
  emitted, verifies that it is absent from pending output and cannot be removed by its private ID,
  then verifies that a genuinely deferred correlated prompt remains visible and cancellable.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.

## Validation

- Focused queue, IPC, and renderer matrix: 4 files / 47 tests passed.
- Full Electron-ABI suite: 467 files passed, one skipped; 4,005 tests passed, one skipped.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. The first typecheck attempt
  overlapped unrelated in-progress workspace edits and failed on their transient
  `AgentDeckMessageRepo.resetDeliveringOnStartup` mismatch; the final run passed after those edits
  became internally consistent.
- Changed production files remain below the 500-line guardrail: `turn-queue.ts` is 485 lines and
  `turn-queue-helpers.ts` is 67 lines.

## Fixes landed

- Grok pending-list conversion now returns a row only for deferred, correlated messages.
- Grok pending cancellation uses the same renderer-visible correlation boundary and cannot remove
  an already-rendered uncorrelated initial prompt.
- Added a failure-first regression covering the exact startup overlap shown in the report.

## Residual risk

- The fix changes main-process code. The currently running Agent Deck process owns this session, so
  it was not restarted in place; the corrected behavior takes effect after the next app restart.
- Non-deferred internal inputs remain intentionally visible only in chat while they await provider
  work. They are not renderer-cancellable because cancellation after durable chat insertion would
  create a ghost transcript entry.

## Follow-up

After restarting Agent Deck, create a Grok Build session with a short first prompt and confirm that
the prompt appears only in chat, while a genuinely deferred follow-up remains in the waiting area
only until Grok accepts it.
