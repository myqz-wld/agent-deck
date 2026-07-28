---
plan_id: PLAN_15
title: Plan-review isolation, pending messages, and expanded composer
status: completed
created_at: 2026-07-21
updated_at: 2026-07-21
completed_at: 2026-07-21
base_branch: main
base_commit: d9fc8e1d4c7adef93bef2f78b1faf03b94f4567a
related_review: REVIEW_165
---

# PLAN_15_plan-review-pending-queue-composer: Preserve review and input boundaries

## Goal and invariants

- Keep internal plan-review sessions out of History and allocate a native fork only after the user
  sends the first real review question.
- Synthesize editable feedback in a fresh, tool-free one-shot from the plan and bounded post-fork
  dialogue only; when no dialogue exists, call no provider and return the exact editable default.
- Keep ordinary input visibly pending until the provider consumes it, allow deletion while it is
  still queued, and let the resulting provider event be the only source of a chat bubble.
- Give the composer a full-frame editor while sharing the inline draft, attachments, IME behavior,
  steering behavior, and send path.
- Preserve adapter defaults, explicit plan approval, public MCP contracts, attachment cleanup,
  hand-off cutover safety, and the 500-line source guardrail.

## Confirmed design decisions

- Persist `hidden_from_history` and allow only trusted initial session-registration paths to set it.
- Use one atomic lazy review-child startup promise so concurrent first actions cannot create two
  forks; restore the question and quotes when startup or send fails.
- Build synthesis input from non-internal user/assistant events strictly after the fork boundary and
  run it in an empty temporary working directory with tools disabled.
- Return `尚未进行审阅对话，暂无修改意见。` locally when no child exists.
- Treat each live adapter queue as authoritative for pending list/delete races. A successful delete
  wins only before consumption; otherwise the provider event and chat bubble win.
- Keep hand-off ingress outside the ordinary pending queue because it is already a durable cutover
  transaction with replay and ownership-transfer guarantees.
- Use one controlled composer state for inline and expanded views, with modal focus isolation.

## Prompt-asset scope

- Updated `src/main/plan-review/prompts.ts` and `README.md` after inventorying and hashing them.
- Kept `resources/claude-config/CLAUDE.md`, `resources/codex-config/CODEX_AGENTS.md`, and
  `src/main/agent-deck-mcp/tools/index.ts` check-only because their public protocol remained valid.
- Stored local pre-edit backups under
  `.prompt-asset-improver/local/backups/20260721T171802Z/` and refreshed the local inventory.

## Completed checklist

- [x] Add migration, repository semantics, trusted registration, and History filtering for hidden
      review sessions.
- [x] Make review-fork creation lazy and failure-recoverable.
- [x] Add fresh bounded post-fork feedback synthesis and the provider-free no-dialogue default.
- [x] Add authoritative pending list/delete APIs, adapter queues, cleanup, and consumption races.
- [x] Render the waiting queue and delay ordinary user bubbles until authoritative consumption.
- [x] Add the shared expanded composer with focus, IME, attachment, and send parity.
- [x] Add focused lifecycle, migration, IPC, adapter-race, and renderer coverage.
- [x] Update user-facing documentation and durable lifecycle records.
- [x] Complete a solo Codex boundary audit after the user explicitly excluded Claude and DeepSeek;
      fix every material finding recorded in `REVIEW_165`.
- [x] Pass the full repository validation suite.

## Validation and completion

- `pnpm typecheck` passed.
- `pnpm test` passed 324 files and 2,925 tests; the one skipped test is the repository's existing
  credentialed Codex live smoke.
- `pnpm build` and `pnpm logger:check` passed.
- Focused tests covered no-open-time fork allocation, hidden History filtering, fresh transcript
  bounds, empty-review fallback, queue consumption/deletion, attachment failures, cancellation,
  active-turn steering, modal focus, IME, and shared-draft behavior.
- `stream-processor.ts` is 495 lines after extracting `user-message-stream.ts`.

## Final status and residual boundaries

Completed on 2026-07-21. No unresolved material finding remains. The automated suite does not call
credentialed live providers by default; provider runners and routing are covered by isolated tests.
The live pending queue intentionally excludes hand-off ingress, whose separate durable cutover path
is documented in the README and preserved unchanged. Runtime restart was explicitly deferred by the
user; no development or installed application process was started after validation.
