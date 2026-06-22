---
plan_id: claude-restart-jsonl-drain-20260622
created_at: 2026-06-22
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 9469073
---

# Goal

Fix the Claude ExitPlanMode approve-bypass restart race where restart jsonl precheck can run before the old SDK query has fully drained, causing a false jsonl-missing fallback and apparent context loss.

# Invariants

- Keep the existing application session id stable during restart.
- Do not touch unrelated dirty files owned by other local sessions.
- Do not change DB schema, renderer behavior, or Codex adapter behavior.
- Restart should not wait indefinitely if the Claude SDK stream fails to drain.

# Design Decisions

- Add a narrow drain signal to Claude `InternalSession`, resolved by `stream-processor` in its `finally` block.
- Make `closeSession()` wait briefly for that drain signal after interrupt/cleanup. Existing restart code already awaits `closeSession`, so the jsonl precheck gets the ordering fix without a broader restart-controller rewrite.
- Use a bounded timeout so ordinary close/delete paths do not hang on a broken SDK stream.

# Tasks

- [completed] Add internal stream-drain promise and close wait.
- [completed] Add focused regression coverage for close waiting and timeout behavior.
- [completed] Run targeted tests.
- [completed] Commit implementation as `9469073 fix claude restart jsonl drain race`.

# Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/exit-plan-hotswitch-and-cancel-resolve.test.ts src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/can-use-tool.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts`
- `pnpm typecheck`

Note: `pnpm test:node -- <files>` unexpectedly ran the full suite; one old handwritten `InternalSession` fixture failed because it lacked the new drain fields. The fixture was updated and targeted tests pass.

# Outcome

Claude restart paths now wait for the previous SDK stream's `finally` block before continuing past `closeSession()`, bounded to 1 second. ExitPlanMode approve-bypass therefore no longer runs jsonl precheck in the window where the old query has been interrupted but has not yet emitted `session-end` or finished stream cleanup.

# Next Session First Action

No handoff needed. If follow-up is required, inspect `git show 9469073` and the related records `CHANGELOG_314.md` / `REVIEW_134.md`.
