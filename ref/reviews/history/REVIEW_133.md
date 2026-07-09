# REVIEW_133

## Trigger Context

User requested changing provider quota refresh frequency from 5 minutes to 10 minutes while a broader deep-review round was already in progress.

During that deep-review, reviewer-codex reported and reviewer-claude independently confirmed a HIGH regression in Codex `spawn_session` return ids after the fast temp-session change.

## Method

Targeted implementation review across:

- Shared provider usage cadence constants.
- Main-process provider usage TTL cache.
- Renderer startup preload quota refresh timer.
- Codex background quota app-server client idle disposal.
- Codex MCP `spawn_session` create-session id contract.
- Codex bridge temp-session to real-id rename behavior.
- Codex app-server assistant-visible message item translation.
- README and regression tests tied to the cadence.

Heterogeneous review coverage:

- reviewer-codex: confirmed the 10-minute quota cadence update had no material issue and reported the stale Codex spawn id HIGH.
- reviewer-claude: independently agreed with the HIGH, verified the same code path, and found no issue in the 10-minute quota cadence update.

## Findings

### HIGH: Codex `spawn_session` returned a temp id that was later renamed away

Status: fixed.

`spawn_session` returned the id from `adapter.createSession`. After the Codex fast-start change, new Codex sessions return a temporary app id immediately, then `thread.started` renames the DB row to the real thread id. Follow-up MCP calls such as `send_message` use `sessionRepo.get(args.sessionId)`, so the returned temp id becomes unresolvable after rename.

Concrete trigger:

- Lead spawns a Codex teammate through `spawn_session`.
- Background `thread.started` renames the temp id to the real id.
- Lead calls `send_message` using the `sessionId` returned by `spawn_session`.
- The target lookup fails with `session ... not found`.

Fix:

- Added a Codex `awaitCanonicalId` create-session option for programmatic callers.
- MCP `spawn_session` passes `awaitCanonicalId` only for `codex-cli`.
- Codex new-session UI paths keep the fast temp-session return path.
- Added bridge and MCP regression tests for the returned canonical id and follow-up `send_message`.

### LOW: Codex quota client idle disposal would drift below the new refresh interval

Status: fixed.

If only the shared renderer/main refresh interval changed to 10 minutes, the Codex cached app-server client would still dispose after 5 minutes. That would reduce background process lifetime but would also stop reusing the client across scheduled quota refreshes, contradicting the current performance design.

Fix:

- `BACKGROUND_USAGE_IDLE_DISPOSE_MS` now follows `PROVIDER_USAGE_REFETCH_MS`.

### LOW: Empty Codex app-server assistant items rendered as `（空消息）`

Status: fixed.

Codex app-server can emit completed `agentMessage` or `plan` items with missing or blank `text`. The translator converted those items into assistant message events with an empty string, and the activity feed then rendered its empty-message placeholder.

Fix:

- Empty or whitespace-only `agentMessage` and `plan` items are ignored in the Codex app-server translator.
- Non-empty assistant-visible items keep their original text.

## Validation

- Targeted Vitest set passed: 6 files, 120 tests.
- `pnpm typecheck` passed.

## Related Changelog

CHANGELOG_312.
