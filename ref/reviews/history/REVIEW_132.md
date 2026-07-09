# REVIEW_132

## Trigger Context

User asked for a simple review after the directory picker, quota cadence, Codex create-session latency, and recent log warning/error fixes. The user then explicitly asked not to use the Claude-side review for this run, so the Claude reviewer was shut down and this record captures the Codex-only review result.

## Method

Codex reviewer inspected the working-tree changes and focused on the Codex temp-session fast-return path. The review reported two HIGH findings. Both were accepted as true and fixed.

## Findings

### HIGH: Codex timeout fallback could suppress its own error/finished cleanup

Status: fixed.

The timeout branch set `internal.intentionallyClosed = true` before calling `resolveWithFallback`. The new close guard then treated the timeout as a user-close path and skipped the timeout error/finished events and temp-key cleanup.

Fix:

- `resolveWithFallback` now distinguishes a fallback-owned abort from a user close.
- The timeout path still marks the turn intentionally closed so `runTurnLoop` exits quietly, but it now emits the timeout error/finished and cleans the temp token.
- Regression coverage advances `THREAD_STARTED_FALLBACK_MS` for a new non-resume session.

### HIGH: Background real-id rename could race post-create writes

Status: fixed.

`createSession` returned the temp id while background `thread.started` handling could immediately rename the temp session to the real id. Callers such as `spawn_session` then performed synchronous post-create writes against the returned temp id; if rename won first, spawn links, team membership, or reply-anchor placeholders could target the stale id.

Fix:

- New-path background thread startup is scheduled for the next macrotask.
- This gives the `await adapter.createSession(...)` caller continuation a synchronous window to register spawn links, team membership, titles, permission metadata, and reply anchors against the temp session before rename can occur.
- Regression coverage asserts `runStreamed` has not started immediately after `createSession` returns and only starts after the timer advances.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts` passed: 8 tests.
- Targeted regression set passed: 7 files, 37 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.

## Related Changelog

CHANGELOG_310 and CHANGELOG_311.
