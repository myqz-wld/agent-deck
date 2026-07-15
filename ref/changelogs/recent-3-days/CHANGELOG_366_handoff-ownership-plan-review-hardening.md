---
changelog_id: 366
changed_at: 2026-07-14
---

# CHANGELOG_366_handoff-ownership-plan-review-hardening: Preserve authority across handoff

## Summary

Timed-out `present_plan` gates, issue mutation authority, and predecessor-trajectory visibility now
follow the current logical session owner across committed handoffs. A source keeps its historical
provenance, but only the latest committed successor may act for it; explicit source reactivation
starts a new ownership epoch. Late plan decisions remain visible and exactly-once retryable, even
through chained handoff, adapter recovery, or post-acceptance projection failure.

Deep Review now uses a full-screen, keyboard-safe plan dialog backed by one isolated provider-native
fork. Users can quote selected plan text, ask questions, approve, continue modifying, or generate
context-derived feedback. Questions and automatic feedback are serialized and correlated to their
actual provider turns, so prior output cannot be submitted as the requested feedback.

## Plan-gate and review-child lifecycle

- Omitting `present_plan.timeoutMs` blocks indefinitely. An explicit timeout releases the MCP call but
  retains the pending gate until a human decision or deliberate owner close.
- Committed handoff rehomes backend ownership before source finalization; renderer and adapter metadata
  projection cannot delete the gate when a successor lookup transiently fails.
- Stable enqueue ids make late decisions idempotent across live and first-caller recovery paths.
- Turn-correlation metadata survives Codex, Claude, and Deepseek recovery and is emitted only when the
  queued turn actually starts.
- Terminal cancellation aborts pending enqueue/output work, closes the child immediately, settles
  queued operations, and memoizes cleanup so close side effects run once.

## Current-owner authorization and visibility

- `append_issue_context` and `update_issue_status` authorize only the current logical owner. Durable
  alias lookup errors deny mutation instead of restoring predecessor authority.
- Issue source/resolution ids remain historical provenance; no issue row is rewritten during handoff.
- Session visibility recursively includes committed predecessors and their related spawn trajectory,
  including rename-created chains.
- Traversal is capped at 1,024 sessions per lineage and 8,192 alias rows globally. Credits are fairly
  assigned to original roots, so a capped wide root cannot starve another root's deeper chain.
- Page limits share each root's credit. Indexed presence probes eliminate empty-frontier N+1, while
  sparse non-empty nodes are read in bounded UNION batches. Repeated successors retain independent
  request keys, offsets, and owner state.

## Review interface and copy

- Added a portal-backed expanded dialog with initial focus, focus trapping, background inerting,
  Escape handling, trigger-focus restoration, and a keyboard-operable quote path.
- Aggregate busy state prevents questions from racing approval, revision, or automatic feedback.
- Fork failures use stable Simplified-Chinese UI copy and never recommend the forbidden fresh-session
  fallback. Prompts direct state-changing work to the current plan-owning session.
- Public MCP descriptions and paired Claude/Codex protocol assets describe the latest committed
  successor rather than an ambiguous original session.

## Validation

- `pnpm test` passed 306 files and 2,829 tests; one explicitly opt-in credentialed Codex live smoke
  remained skipped. All better-sqlite3 tests ran under Electron's matching ABI.
- Real SQLite regressions cover chained rename lineage, current-owner reactivation, competing root
  fairness, and a 1,022-empty-leaf frontier. The latter performs exactly 22 alias SELECT statements.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. Changed implementation files remain
  below the 500-line limit.
- The requested standalone `gpt-5.6-sol` / `max` reviewer completed repeated read-only rounds and
  finished with zero CRITICAL, HIGH, MEDIUM, or LOW findings.

## Do Not Split Protection

- Gate retention, ownership rehome, stable enqueue acceptance, and retry behavior form one late-
  decision contract. Omitting any part can lose or duplicate a human decision.
- Deferred turn markers, recovery propagation, terminal abort, and child cleanup form one correlated-
  operation contract. Partial delivery can capture unrelated output or leave a child alive.
- Strict issue authorization, durable aliases, root-fair traversal, and batched frontier reads form one
  ownership contract. Provenance rewriting or fail-soft authorization would weaken it.

## Related records

- [PLAN_12](../../plans/recent-3-days/PLAN_12_handoff-ownership-plan-review-hardening.md)
- [REVIEW_161](../../reviews/recent-3-days/REVIEW_161_handoff-ownership-plan-review-hardening.md)
