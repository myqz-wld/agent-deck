# CHANGELOG_317 — Claude restart phantom-jsonl self-heal uses message freshness

## Summary

Claude restart jsonl fallback now treats `applicationSid.jsonl` as resumable in restart flows when it is fresh enough relative to the latest real conversation message, even if it is older than the session row's generic `lastEventAt`.

## Problem

A user log from 2026-06-23 showed the previous stream-drain fix working: the old Claude stream emitted `session-end` / `[ede_diagnostic] ... stop_reason=tool_use` before `claude-jsonl-fallback` ran its precheck. However, precheck still missed `cliSessionId=<runtime-id>.jsonl` and fell back to a fresh CLI thread.

That shape matches the known phantom-runtime-id case:

- The persisted `cli_session_id` can point at a runtime id that never writes a transcript file.
- The real transcript remains under `applicationSid.jsonl`.
- The read-side self-heal already probes `applicationSid.jsonl`, but its freshness gate compared mtime against `SessionRecord.lastEventAt`.
- In restart flows, `lastEventAt` can be advanced by application-side lifecycle / waiting / cancellation events that are not reliable transcript freshness boundaries.

## Change

- `maybeJsonlFallback()` keeps the existing primary `cliSessionId` check and application-sid self-heal.
- When `applicationSid.jsonl` exists but fails the generic `lastEventAt` freshness cutoff, restart flows now read the latest real conversation message via `listMessagesFn(sessionId, 1)`.
- If the jsonl mtime is fresh enough relative to that latest message, the helper returns `healedCliSessionId=applicationSid` and lets the caller resume the real transcript instead of fresh-fallbacking.
- Recover flows keep the stricter original `lastEventAt` gate.
- The stale-skip log now includes the restart message freshness cutoff when applicable.

## Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/exit-plan-hotswitch-and-cancel-resolve.test.ts`
- `pnpm typecheck`

## Related Records

- REVIEW_137
- Plan: `claude-exit-plan-jsonl-precheck-20260623`
