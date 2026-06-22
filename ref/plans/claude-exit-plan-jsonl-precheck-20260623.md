---
plan_id: claude-exit-plan-jsonl-precheck-20260623
status: completed
created_at: 2026-06-23
base_commit: 010b8f3
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# Goal

Diagnose and fix the Claude ExitPlanMode approve-bypass restart path still reporting `claude-jsonl-fallback precheck MISS` and falling back to fresh CLI after the old SDK stream has already ended.

# Invariants

- Keep the application session id stable through restart.
- Prefer real Claude jsonl resume whenever the jsonl exists.
- Use fresh fallback only when both the primary cli sid and safe application sid checks miss.
- Do not change Codex adapter behavior.
- Preserve bounded close behavior: close/restart must not hang forever on a broken SDK stream.
- Preserve existing fresh fallback history injection behavior for true jsonl-missing cases.

# Evidence

- User log from 2026-06-23 showed `session-end` and `[ede_diagnostic] ... stop_reason=tool_use` before `claude-jsonl-fallback precheck MISS`.
- Installed app and source both contained the prior `streamDrained` fix from CHANGELOG_314, so this was not the old pre-drain race.
- The failing precheck used `sessionId != cliSessionId`, matching the phantom-runtime-id family from CHANGELOG_224.
- Existing read-side self-heal probed `applicationSid.jsonl`, but could reject it if mtime was older than broad `SessionRecord.lastEventAt`.

# Design Decision

For restart flows only, use latest real conversation message time as a secondary freshness boundary when `applicationSid.jsonl` exists but fails the broad `lastEventAt` gate.

This keeps the true-fork protection: if newer conversation messages exist after the applicationSid jsonl mtime, the helper still rejects self-heal and falls back. Recover flows keep their original stricter gate.

# Tasks

- [completed] Inspect close/restart/jsonl fallback code and existing tests.
- [completed] Confirm current installed/source build contains the stream-drain fix.
- [completed] Add regression coverage for restart message-freshness self-heal and stale rejection.
- [completed] Implement restart-only secondary freshness check.
- [completed] Run focused tests and `pnpm typecheck`.
- [completed] Archive changelog/review/plan records.

# Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/exit-plan-hotswitch-and-cancel-resolve.test.ts`
- `pnpm typecheck`

# Outcome

Claude restart jsonl fallback can now recover from a persisted phantom `cli_session_id` when the real `applicationSid.jsonl` is fresh enough relative to the latest conversation message. This avoids unnecessary fresh CLI fallback after ExitPlanMode approve-bypass while retaining stale-jsonl protection.

# Next Session First Action

No handoff required. If follow-up is needed, inspect `src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts`, `src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts`, and related records CHANGELOG_317 / REVIEW_137.
