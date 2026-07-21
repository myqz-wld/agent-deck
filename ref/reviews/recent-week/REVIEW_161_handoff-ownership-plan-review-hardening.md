---
review_id: 161
reviewed_at: 2026-07-14
baseline_commit: 5b5654c52a32cebf66187c4a7795dff553b1f5a0
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused review covers the current-owner handoff, plan-review, adapter-recovery, issue-authority, lineage, and renderer scope below."
---

# REVIEW_161_handoff-ownership-plan-review-hardening: Current-owner lifecycle

## Scope and method

A standalone `gpt-5.6-sol` / `max` session performed repeated independent read-only rounds over the
live worktree. It traced queue acceptance, recovery, handoff commit/finalization, issue authorization,
recursive visibility, SQLite query bounds, child operation teardown, and renderer focus/action races.
Every confirmed finding was fixed with a focused regression and returned to the same reviewer. Its
final verdict was `READY` with zero findings at every severity.

```review-scope
README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/adapters/enqueue-idempotency.ts
src/main/adapters/types/agent-adapter.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts
src/main/adapters/claude-code/sdk-bridge/message-controller.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/codex-cli/sdk-bridge/codex-jsonl-fallback.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/session-retirement.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/agent-deck-mcp/tools/handlers/append-issue-context.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/list.ts
src/main/agent-deck-mcp/tools/handlers/request-plan-review.ts
src/main/agent-deck-mcp/tools/handlers/spawn-prompt.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/update-issue-status.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/issues.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/event-bus.ts
src/main/ipc/adapters-message-dispatch.ts
src/main/ipc/plan-review.ts
src/main/ipc/session-hand-off.ts
src/main/plan-review/deep-review-session.ts
src/main/plan-review/prompts.ts
src/main/plan-review/service.ts
src/main/session/hand-off/cutover-coordinator.ts
src/main/session/hand-off/ownership.ts
src/main/store/session-handoff-alias-repo.ts
src/preload/api/plan-review.ts
src/preload/index.ts
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/pending-rows/plan-markdown-panel.tsx
src/shared/ipc-channels.ts
src/shared/types/permission.ts
```

## Confirmed finding history

Across the adversarial rounds, the reviewer reported no CRITICAL issue and confirmed five HIGH,
thirteen MEDIUM, and five LOW defects or narrowed failure-path refinements. All were fixed. The main
resolution groups were:

| Maximum severity | Finding group | Final resolution |
|---|---|---|
| HIGH | Source close could delete a timed-out gate after committed handoff. | Rehome backend ownership at commit before source finalization; make metadata/UI projection best-effort. |
| HIGH | Automatic feedback could capture the preceding queued turn. | Correlate to the actual dequeued turn id and terminal event; serialize child operations. |
| HIGH | Retried late decisions could execute twice after queue mutation but before projection returned. | Use stable enqueue ids and adapter-side acknowledged idempotency for live and recovery-first paths. |
| HIGH | A historical issue owner could remain authorized after successor commit. | Resolve only the strict current logical owner; reactivation removes the alias and starts a new epoch. |
| MEDIUM | Recovery, close, and pending enqueue races could hang or double-close the review child. | Preserve markers through recovery, race enqueue with abort, close first, settle tails, and memoize cleanup. |
| MEDIUM | Recursive lineage could be incomplete, unfair, unbounded, or synchronous N+1. | Use root credits, global/cap bounds, keyed SQL pages, batched presence probes, and sparse-frontier batches. |
| MEDIUM | Modal focus and terminal-action races allowed background interaction or late questions. | Trap/restore focus, inert the background, support keyboard quoting, and gate every operation synchronously. |
| LOW | Backend hints, schemas, prompts, and records described stale owners or fresh fallback. | Align stable Chinese errors and all public/prompt copy to the current plan-owning/latest-successor model. |

## Final reviewer verification

- Final result: 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW; verdict `READY`.
- A 1,022-empty-leaf lineage performs 16 bounded parent pages plus six 200-id indexed probes, exactly
  22 alias SELECTs rather than the prior 1,038 synchronous queries.
- Sparse non-empty nodes share one root's credit across a UNION batch; the sum of all limits remains
  at most `min(credit, 64, remaining lineage capacity)`.
- A capped root cannot consume another root's budget. The production SQLite regression retains the
  competing deep lineage `[root-b, b1, b2, b3]` and never reads/probes the capped root's children.
- Global 8,192-row, per-lineage 1,024-node, cycle, duplicate, repeated-successor, 200-term SQL, and
  800-bind boundaries were rechecked against production control flow.
- Late-decision idempotency, first-runtime recovery, strict issue authorization, handoff event order,
  child abort/cleanup, and modal focus/busy behavior showed no regression.

## Lead validation and deployment note

- `pnpm test` passed 306 files and 2,829 tests with one opt-in credentialed Codex live smoke skipped.
  SQLite tests ran under Electron's matching native ABI.
- The focused handoff/ownership/SQLite set passed 3 files and 25 tests.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. Reviewed ownership files are 298 and
  230 lines; all changed implementation files remain below 500 lines.
- Confirmed prompt assets were backed up before editing, paired Claude/Codex semantics match, and the
  scoped local inventory hashes match the current assets.
- Browser attachment failed with `Cannot redefine property: process`; renderer tests cover the visible
  interaction path. The installed application needs a safe restart/rebuild to load the new code.

## Residual risk

- Pure graph depth is inherently sequential, but traversal stops at the 1,024-node lineage cap and
  does not become list-entry or empty-frontier N+1.
- Provider-native fork creation can fail at an unsafe provider boundary. The UI reports that failure
  and intentionally does not create a fresh, context-free replacement.
- Retained timed-out gates live until a human response or deliberate owner close, which is the
  requested blocking behavior and remains bounded by session lifecycle.
