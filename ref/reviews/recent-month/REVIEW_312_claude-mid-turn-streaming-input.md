---
review_id: 312
reviewed_at: 2026-10-02
baseline_commit: 17b48bbab7f855140f96c58e3a26c275c18b1bfe
expired: false
---

# Claude mid-turn streaming input

## Scope

Bounded debugging and regression validation of composer messages remaining in the pending queue
while Claude Code was working. This is a local engineering audit, not an independent paired
review. The review-expiry script was run; unrelated expired coverage receives no exemption.

```review-scope
src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.test.ts
src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.ts
src/main/adapters/claude-code/sdk-bridge/query-options-builder-core.test.ts
src/main/adapters/claude-code/sdk-bridge/query-options-builder-core.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor-core.test.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor-core.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
```

## Findings and fixes landed

1. The SDK already used streaming input and `priority: 'now'`, but the application iterator refused
   to yield any additional input while `userTurnInFlight` was true. Deferred composer messages now
   stream during the active turn, with at most one unacknowledged submission. Acceptance wakes
   the iterator to deliver the next composer message. Internal continuation turns retain their
   existing sequential scheduling.
2. Uncorrelated assistant output cannot establish acceptance for a mid-turn correction. Enable
   `--replay-user-messages` and match the submitted UUID against user echoes or the SDK's
   `user_message_uuid` / `user_message_uuids` fields on top-level response frames. Subagent output
   cannot acknowledge a main-session input. The idle-input UUID-rewrite fallback remains bounded
   to submissions made without an earlier turn in flight.
3. A preceding turn's result must not discard a pending correction or allow a Gateway/cwd switch
   while that input remains submitted. Preserve the submission across unrelated results and retain
   the busy state. Cancelling a correction preserves the earlier turn's active state; provider
   acceptance still wins cancellation races.
4. Lazy attachment I/O could cross a cwd-transition or retirement gate. Recheck the gates before
   removing the queue head and yielding the materialized message.

## Validation and evidence

- Before the fix, the new active-turn delivery regression and attachment-transition regression
  both failed. Both pass with the fix.
- `pnpm typecheck` passed, including architecture boundaries and both TypeScript projects.
- `pnpm test` passed: 1,130 files / 7,001 tests; 3 files / 6 existing conditional skips.
- After tightening correlation across repeated preceding-turn results, the complete Claude
  adapter suite passed again: 126 files / 504 tests, as did `pnpm typecheck`.
- `pnpm build` passed for main, preload, and renderer outputs.
- Tests cover delivery before the current result, consecutive corrections, provider correlation,
  subagent isolation, cancellation races, result ordering, attachments, and existing retirement
  and worktree-transition behavior.
- The installed SDK's streaming transport writes each yielded user message directly to the
  subprocess. Its type definitions expose `priority` and response correlation fields. The
  [official streaming-input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
  describes the persistent input stream; the
  [CLI reference](https://code.claude.com/docs/en/cli-reference) documents user-message replay
  acknowledgements.
- `git diff --check` passed. All changed source and test files remain below 500 lines.

## Residual risk and follow-ups

The provider still controls when streamed input joins model context. The fix removes the local
whole-turn barrier and waits for correlated acceptance; it does not force an immediate abort or
promise consumption during an outstanding provider request/tool call.

Validation used deterministic provider frames, not a live paid model conversation. No running
Agent Deck process, installed application, or Worker was stopped, replaced, or restarted. The
installed application requires a new build and installation/restart to activate this main-process
change. Existing provider queries must be recreated to receive the new replay option.
