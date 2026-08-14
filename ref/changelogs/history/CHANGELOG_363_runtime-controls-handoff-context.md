---
changelog_id: 363
changed_at: 2026-07-14
---

# CHANGELOG_363_runtime-controls-handoff-context: Auto-save runtime controls and restore hand-off coverage

## Summary

Active SDK sessions now save model and Thinking edits automatically for the next provider turn, so
the explicit “应用到下一轮” button is gone. Model text edits coalesce briefly, Thinking changes flush
the latest combined selection immediately, and stale asynchronous completions cannot replace a newer
draft or surface an error from a previously selected session.

UI hand-off and MCP `hand_off_session` also stop starving Continuation Context checkpoint generation
with duplicated, multi-megabyte tool telemetry. The shared engine now compacts that telemetry,
deduplicates only byte-identical completed-tool inputs, uses a larger bounded fold budget, and has an
evidence-backed 300-second hand-off deadline.

## Active-session runtime controls

- Removed the manual apply button and added copy stating that edits save automatically without
  interrupting the current reply.
- Coalesces free-text model edits for 250 ms while applying Thinking dropdown changes immediately.
- Serializes persistence per session and identifies every snapshot by session plus revision, so an
  older success or failure cannot clear, replace, or report against the latest draft.
- Flushes a queued selection on unmount and keeps the controls editable while persistence is active.

## Continuation Context coverage

- Raised the default generator fold-input budget from 32,000 to 96,000 estimated tokens. Observed
  context windows reserve 32,000 tokens for checkpoint output, instructions, and accounting variance,
  with a 128,000-token input cap and the existing 512 KiB prompt guard.
- Bounds tool-start, tool-end, and file-change telemetry to 256-byte prefix/suffix evidence with the
  original byte count, SHA-256 digest, and truncation marker. Ordinary messages retain their existing
  32 KiB normalization limit.
- Removes a completed tool-start event only when the corresponding end event contains a byte-identical
  serialized `toolInput`; unmatched starts and provider end events without input remain available.
- Raised only the shared UI/MCP hand-off checkpoint deadline from 120 to 300 seconds. Missing-provider-
  history recovery keeps its separate 30-second boundary.
- Logs bounded failure stage, category, provider-call count, checkpoint/capture revision, and remaining
  deadline. Prompts and raw provider errors are neither logged nor returned in warning messages.

## Validation

- Production logs showed repeated MCP hand-offs finishing after about 123 seconds with
  `checkpoint-generation-failed` and `coverage-gap`; provider rollout evidence confirmed that model
  and Thinking selection did not downgrade.
- Read-only production reconstruction found a checkpoint at revision 40 against capture revision
  4,426. A credentialed isolated Codex/high reproduction timed out at 120.445 seconds and completed
  the same bounded full-backlog fold in 201.154 seconds with a 240-second allowance.
- `pnpm test` passed 286 files and 2,675 tests; one credentialed live smoke remained skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Browser automation could not attach because the bundled browser client conflicted with the current
  runtime's non-redefinable `process` property. Eight focused renderer tests cover the removed button,
  automatic persistence, rapid edits, and session switching.

## Do Not Split Protection

- Telemetry compaction, the larger fold budget, the longer hand-off deadline, and bounded diagnostics
  are one repair unit. Raising only the budget or deadline leaves the production amplifier intact;
  compacting alone still lacks headroom for the observed 201-second high-effort generation.
- Automatic persistence and its session/revision race protection must ship together; removing the
  button without serialization would permit stale writes and errors to affect a newer selection.

## Related records

- [REVIEW_158](../../reviews/recent-week/REVIEW_158_handoff-context-coverage.md)
- [PLAN_9](../../plans/recent-week/PLAN_9_runtime-controls-handoff-context.md)
