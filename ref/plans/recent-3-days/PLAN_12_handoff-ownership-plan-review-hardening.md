---
plan_id: PLAN_12
title: Handoff ownership continuity and plan-review lifecycle hardening
status: completed
created_at: 2026-07-14
updated_at: 2026-07-14
completed_at: 2026-07-14
base_branch: main
base_commit: 5b5654c52a32cebf66187c4a7795dff553b1f5a0
related_changelog: CHANGELOG_366
related_review: REVIEW_161
---

# PLAN_12_handoff-ownership-plan-review-hardening: Preserve authority across handoff

## Goal and invariants

- A committed handoff replaces the logical session owner without losing a timed-out plan gate,
  issue authority, or legitimate predecessor-trajectory visibility.
- Historical issue provenance remains immutable. After handoff, only the latest committed successor
  is authorized; explicit predecessor reactivation starts a new ownership epoch.
- A late plan decision executes exactly once, even when adapter projection fails after queue
  acceptance or the target runtime must be recovered.
- Review-child questions and automatic feedback consume output only from their own provider turn and
  settle promptly when enqueue, recovery, owner cancellation, or child close races them.
- Lineage reads remain fail-closed for authorization and bounded by per-root, global-row, SQL-chunk,
  cycle, and depth limits without synchronous frontier N+1 behavior.
- Existing task, team, worktree, message-routing, public `spawn_session`, native ExitPlanMode, and
  `present_diff` behavior remain unchanged.

## Confirmed scope and decisions

- Rehome retained plan gates at the committed ownership boundary before source finalization. Backend
  routing is authoritative; renderer and successor metadata projection are best-effort.
- Carry stable enqueue keys and turn-correlation ids through live and first-caller recovery paths for
  Codex, Claude, and Deepseek.
- Keep issue source/resolution provenance unchanged while resolving authorization through the strict
  durable handoff alias. Lookup failure denies mutation.
- Resolve visibility lineage in bounded batches. Credits belong to the original queried root, page
  limits share that credit, and unknown frontier nodes use indexed presence probes before page reads.
- Keep the review fork same-adapter, same-realpath-cwd, provider-native, and read-mostly by instruction;
  never silently substitute a fresh session.
- Preserve unrelated automatic Continuation Context checkpoint work that landed concurrently at
  `5b5654c5`.

## Completed checklist

- [x] Audit plan-gate, handoff, issue, trajectory-read, adapter recovery, and renderer authority paths.
- [x] Retain explicitly timed-out plan gates and rehome them across chained/cross-adapter handoffs.
- [x] Make late decisions queue-acceptance idempotent and retryable only before acknowledged acceptance.
- [x] Correlate review turns to actual dequeue/start markers across live and first-runtime recovery.
- [x] Make child cleanup exactly-once and abort-aware across pending enqueue, output, and close races.
- [x] Restrict issue mutation to the current logical owner and fail closed on durable lookup errors.
- [x] Add recursive, fair, capped, cycle-safe predecessor visibility without per-session DB reads.
- [x] Batch empty and sparse non-empty frontier processing under shared original-root credits.
- [x] Complete modal focus, keyboard quote, aggregate-busy, stable Chinese error, and current-owner copy.
- [x] Back up, align, and validate the confirmed paired prompt/tool assets and scoped inventory.
- [x] Pass focused and full Electron/SQLite tests, full typecheck, production build, and diff checks.
- [x] Complete the requested independent `gpt-5.6-sol` / `max` review with no remaining finding.

## Validation and residual risk

- `pnpm test` passed 306 files and 2,829 tests. The sole skipped test is the explicitly opt-in
  credentialed Codex live smoke; every SQLite regression executed under the matching Electron ABI.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. The final ownership traversal and
  alias repository are 298 and 230 lines.
- A real 1,022-empty-leaf alias graph executes 22 alias SELECT statements instead of 1,038. A real
  competing wide-root/deep-root graph retains `b3`; a sparse non-empty frontier shares at most 64
  rows of root credit per batch.
- The in-app Browser could not attach because its bundled client attempted to redefine `process`.
  Focus, quote, busy-state, decision, and error behavior are covered by renderer tests instead.
- Provider-native fork eligibility remains authoritative. If a provider cannot create the fork at a
  safe boundary, the dialog reports the failure and does not create a context-free substitute.
- The installed Agent Deck host must be restarted or rebuilt before its current main/preload process
  can use this delivery.

## Completion

Plan gates, review-child turns, issue authority, trajectory visibility, adapter recovery, renderer
accessibility, prompt semantics, and handoff ownership now follow one current-logical-owner contract.
The final independent read-only review reported zero findings at every severity.
