---
plan_id: codex-create-session-latency-20260619
status: completed
created_at: 2026-06-19
base_commit: d50c906
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# Goal

Reduce avoidable latency when creating a new Codex session without changing session lifecycle semantics, recovery behavior, sandbox/permission defaults, or quota refresh cadence.

# Non-Goals

- Do not change provider quota background refresh cadence; it remains 5 minutes per the latest user correction.
- Do not replace Codex app-server APIs or change thread persistence semantics without evidence.
- Do not weaken startup/recovery guards that prevent duplicate sessions, orphan rows, or lost user messages.

# Invariants

- New Codex sessions still create exactly one app DB session and one Codex app-server thread.
- First user prompt and attachments are still delivered once.
- Existing recover/restart/session-finalize tests must stay green.
- Directory picker optimization already landed in the current working tree and should not be reverted.

# Checklist

- [x] Trace Codex `createAdapterSession` path and identify synchronous or serial waits.
- [x] Check recent changelogs/reviews for Codex app-server startup, thread creation, quota, and hook setup constraints.
- [x] Measure or infer the likely latency contributors from code and tests.
- [x] Apply only narrow, evidence-backed optimization if a safe candidate exists.
- [x] Add/update regression tests for any timing/concurrency behavior changed.
- [x] Validate targeted tests and `pnpm typecheck`.

# Progress

- Created after the user added: "codex创建会话比较慢，这里看看有没有优化时间".
- Existing completed work in this turn: directory picker now dedupes repeated selection clicks and shows a pending state; provider quota refresh remains 5 minutes.
- Traced the Codex new-session path: renderer IPC waited for `adapter.createSession`, which waited for `runCreateSessionNewPath`; that awaited `threadLoop.startNewThreadAndAwaitId`, which waits for app-server initialize plus `thread/start` and the first `thread.started` event before returning.
- Implemented the optimization by emitting a visible temp session immediately, persisting its spawn fields, returning the temp sid to the caller, and letting `threadLoop.startNewThreadAndAwaitId` finish in the background. On success it uses the existing `sessionManager.renameSdkSession(temp, real)` path; on early error/timeout it only appends error/finished to the already-visible temp session.
- Added a close-before-real-id guard so a user closing the temp session before `thread.started` cannot have a late real id rename/revive it.
- Added tests in `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts` for immediate temp return, no duplicate start/user events, early error fallback, and late real id after close.
- Validated targeted Vitest set and `pnpm typecheck`.

# Risks

- Codex app-server lifecycle has prior fixes around resume IDs, sandbox switching, background quota probes, and internal hook filtering. Optimizing startup must not bypass those safeguards.
- Perceived "create session" latency may include first model turn latency, which may not be safely reducible in Agent Deck without changing UX.

# Closeout

- Implemented in `1ee2972` with changelog/review records `CHANGELOG_310`, `CHANGELOG_311`, `REVIEW_130`, `REVIEW_131`, and `REVIEW_132`.
- Follow-up deep review found the MCP `spawn_session` temp-id handle regression introduced by this fast-return path; fixed in `6006241` and recorded in `CHANGELOG_312` / `REVIEW_133`.
- The original non-goal about provider quota refresh staying at 5 minutes reflected this plan's initial scope. A later user request changed that cadence to 10 minutes in `6006241`.
