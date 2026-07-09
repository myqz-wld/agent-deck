# REVIEW_142

## Trigger Context

Issue `817ddcfa-39f6-49a9-81dd-4dbcdcb17094` reported that a benchmark worker could see an active lead session through `list_sessions`, but repeated `send_message` calls to that lead returned `session ... not found`.

The affected path was:

- `src/main/agent-deck-mcp/tools/handlers/send.ts`
- `src/main/agent-deck-mcp/tools/handlers/list.ts`
- `src/main/store/session-repo/core-crud.ts`
- `src/main/store/session-repo/types.ts`
- `src/main/agent-deck-mcp/__tests__/tools.test.ts`

## Method

- Compared `list_sessions` projection with `send_message` target lookup.
- Checked `SessionRecord` row mapping to confirm `list_sessions` returns canonical `sessions.id`.
- Reviewed session id split semantics: `sessions.id` is the application-stable id, while `cli_session_id` may track the current SDK/thread id.
- Added a regression test for a shared-team worker sending to a target by `cliSessionId`.

## Gate Result

PASS.

Severity distribution:

- CRITICAL: 0
- HIGH: 1 fixed
- MEDIUM: 0
- LOW: 0

## Decision List

### HIGH fixed: send_message rejected valid target aliases before authorization

Decision: fixed.

Evidence:

```ts
const target = sessionRepo.get(args.sessionId);
if (!target) {
  return err(`session ${args.sessionId} not found`);
}
```

The write path only accepted canonical `sessions.id`. When a caller had a valid SDK/thread alias for the same Agent Deck session, the handler failed before shared-team authorization and before enqueue.

Fix:

```ts
function resolveSendTarget(sessionId: string): SessionRecord | null {
  return sessionRepo.get(sessionId) ?? sessionRepo.findByCliSessionId(sessionId);
}
```

After lookup, the handler uses `target.id` for self-send, shared-team, reply pair-scope, enqueue, and the returned `sessionId`.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` passed: 87 tests.
- `pnpm typecheck` passed.

## Related Changelog

[CHANGELOG_334](../../changelogs/history/CHANGELOG_334.md).
