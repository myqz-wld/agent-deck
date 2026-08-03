---
changelog_id: 414
changed_at: 2026-07-29
---

# CHANGELOG_414_post-acceptance-delivery-durability: Prevent uncertain redelivery

## Summary

Define universal-message delivery as at-most-once after adapter queue acceptance. An outcome that
cannot be confirmed durably is now failed rather than replayed, preventing the same collaboration
instruction from being injected into a receiver twice after restart.

## Changes

### Acceptance and recovery contract

- Treat `receiveTeammateMessage` resolution as the adapter queue-acceptance boundary and pass the
  durable message id as the adapter enqueue idempotency key.
- Retry only definite pre-acceptance rejection. Once accepted, a failed delivered-status write and
  its failed compensation never return the envelope to pending.
- On startup, terminalize leftover `delivering` rows as failed with an explicit at-most-once reason
  instead of resetting them to pending.

### Shutdown observability

- Add a global durable `delivering` count and require both the in-memory active call set and the
  durable count to reach zero before global watcher stop reports drained.
- Preserve the session-scoped durable probe used by handoff while sharing the same drain result
  shape and fail-closed probe behavior.

### Regression coverage

- Cover accepted delivery followed by both terminal status writes failing.
- Cover global stop after the active map clears while the durable row remains `delivering`.
- Cover restart terminalization and prove that the adapter does not receive a second injection.

## Validation

- `pnpm test src/main/teams/__tests__/universal-message-watcher-durability.test.ts src/main/teams/__tests__/universal-message-watcher.test.ts src/main/store/__tests__/agent-deck-message-repo.test.ts`
  (3 files, 68 tests passed)
- `pnpm typecheck`
- `pnpm test` (468 files passed, 1 skipped; 4,006 tests passed, 1 skipped)
- `pnpm build`

## Do Not Split Protection

All changed production files remain below 500 lines. The new durability regression cases live in a
dedicated test file instead of expanding the existing watcher suite further.

## Related issue

- `cf40544a-43b7-4fe7-87d0-ad0c5d2cd01d` — Define post-acceptance message delivery durability
  semantics.
