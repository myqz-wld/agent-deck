# REVIEW_136

## Trigger Context

User reported that Claude-side session creation was noticeably laggier than Codex-side creation and asked to investigate with application logs.

## Method

Targeted local performance/debug review:

- Parsed `~/Library/Logs/Agent Deck/main-2026-06-22.log` for Claude create timing.
- Compared renderer -> IPC -> adapter create-session paths for Claude and Codex.
- Read related records: `CHANGELOG_310`, `CHANGELOG_312`, `REVIEW_130`, `REVIEW_133`, and `claude-restart-jsonl-drain-20260622`.
- Added regression tests around the changed session lifecycle boundary.

No multi-agent review was used because the issue was a narrow measured parity gap with existing Codex precedent and targeted regression coverage.

## Findings

### MEDIUM: Claude UI create waited for SDK first id before returning

Status: fixed.

Log evidence showed the hook reclaim phase was not the slow part. Eight non-provider-probe Claude creates had `expect sdk session` to hook reclaim around 246-321 ms, but `expect sdk session` to DB-visible session was 642-3315 ms. That matched the code path: the renderer awaited `createAdapterSession`, main IPC awaited `adapter.createSession`, and Claude `createSessionImpl` awaited `runCreateSessionSdkQuery` plus `waitForRealSessionId` before `finalizeSessionStart`.

Fix:

- `create-session-impl.ts:202` marks new non-resume UI creates as `initialSessionEmitted`.
- `create-session-impl.ts:204-258` now emits a temp visible session and first user message, schedules SDK startup in the background, and returns the temp id immediately.
- `session-finalize.ts:97-137` gained `skipSessionStartEmit` so post-rename metadata persistence does not duplicate session-start.

Regression coverage:

- `createsession-fail-fast.test.ts` covers default fast return, background rename, and no duplicate initial events.
- Existing canonical-mode tests were updated to pass `awaitCanonicalId: true`.

### HIGH: Programmatic MCP spawns cannot receive temporary ids

Status: fixed.

The Codex fast-return follow-up in `REVIEW_133` already proved that MCP callers need a stable id for immediate follow-up tools. Applying the same fast-return behavior to Claude would have regressed `spawn_session` unless programmatic creates opted out.

Fix:

- `spawn.ts:446` now passes `awaitCanonicalId: true` for all adapters.
- Claude and Deepseek-Claude adapters pass that flag through to the bridge.
- `options-builder.ts` and `create-session-opts.ts` include the field in typed passthrough coverage.

Regression coverage:

- `src/main/agent-deck-mcp/__tests__/tools.test.ts` remains green with the all-adapter canonical create contract.

### MEDIUM: Fast-return temp sessions need close-before-first-id protection

Status: fixed.

Once a temporary session becomes visible immediately, the user can close it before the SDK first id arrives. Without a guard, a late first-id frame could mutate or rename a closed temp session.

Fix:

- `create-session-sdk-query.ts:116-118` aborts background SDK startup if the visible temp session was closed or replaced before registration.
- `stream-processor.ts:289-300` skips first-id mutation for a new spawn when the temp key no longer owns the live internal session.
- Visible background startup failures append an error and failed finish event only when the temp session still exists and is not closed.

Regression coverage:

- The fast-return test asserts the normal background rename path.
- Existing failure-cleanup and setTimeout fallback symmetry tests continue to pass after the new guards.

## Validation

- Targeted Vitest set passed: 5 files, 94 tests.
- `pnpm exec tsc --noEmit --pretty false` passed.
- `pnpm build` passed.

## Related Changelog

CHANGELOG_316.
