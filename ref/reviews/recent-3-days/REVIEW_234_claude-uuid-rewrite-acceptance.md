---
review_id: 234
reviewed_at: 2026-08-12
baseline_commit: 3ec408aff18c85bdbd4ebb839d4e63a9dbf056e4
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record, rebucketing, and index maintenance are mechanical."
---

# REVIEW_234_claude-uuid-rewrite-acceptance: Claude deferred-input acceptance

## Scope and method

This review traced a live Claude Code turn where the queued message remained visible even though the
model had already answered. Read-only inspection covered the installed application's event database,
the corresponding Claude transcript, and the complete deferred-input acceptance path. The installed
application and the source tree shared the baseline commit above; Claude Code 2.1.226 persisted a
different user-frame UUID from the one supplied by the SDK adapter.

```review-scope
src/main/adapters/claude-code/sdk-bridge/message-controller-core.ts
src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.test.ts
src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.test.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Deferred-input acceptance required the provider's echoed user UUID to equal the adapter-generated UUID. Claude Code 2.1.226 rewrote that UUID before persisting the user frame, so acceptance never fired: the pending row survived while assistant events were emitted, and terminal cleanup could discard the in-flight marker without ever recording the accepted user instruction in chat history. | Retain exact user-UUID matching as the fast path, then treat the first top-level assistant frame as downstream proof that the sole in-flight main user turn was accepted. Emit the deferred user event before translating that assistant frame, and exclude subagent assistant frames from the fallback. |

## Validation and evidence

- The live transcript showed queue enqueue/dequeue records followed by a persisted user frame whose
  UUID differed from its prompt correlation ID, then top-level assistant output. The matching event
  database interval contained assistant/tool/finished events but no user event.
- Focused acceptance, translation-order, pending-outgoing, and stream tests passed: 4 files / 17
  tests.
- The complete Claude adapter suite passed: 130 files / 513 tests.
- The repository Electron suite passed: 905 files / 5,851 tests, with 2 files / 3 existing
  conditional skips.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.

## Fixes landed

- Exact echoed user UUIDs continue to accept deferred input immediately.
- A top-level assistant frame now accepts the current sole in-flight main turn when Claude rewrites
  the user UUID.
- Acceptance still emits the user event before the assistant event, preserving conversation order.
- Assistant frames owned by subagents cannot acknowledge a main-session pending message.
- Existing cancellation identity checks continue to make provider acceptance authoritative if it
  wins the race and make later cancellation cleanup a no-op for that accepted message.

## Residual risk

- When Claude rewrites the UUID, the pending row can remain until the first top-level assistant
  frame. That frame is the earliest correlated downstream signal available without accepting an
  unrelated system or subagent event.
- A terminal provider failure before either a matching user echo or main assistant output retains
  the existing failure cleanup behavior; it is outside the reported accepted-and-responding case.
- The installed application was inspected but not mutated or replayed. It must be rebuilt,
  installed, and restarted before this source fix is active in that runtime.

## Verdict

PASS. The observed UUID-rewrite failure is fixed with targeted ordering and subagent-boundary
coverage, and all repository validation gates passed.
