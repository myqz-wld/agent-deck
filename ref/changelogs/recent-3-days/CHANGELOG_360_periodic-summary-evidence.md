---
changelog_id: 360
changed_at: 2026-07-11
---

# CHANGELOG_360_periodic-summary-evidence: Make periodic summaries evidence-rich and revision-safe

## Summary

Periodic session summaries now use a bounded, immutable evidence snapshot instead of inferring the
task from a small assistant-only event tail. The session card still shows a compact headline, while
the Summary view can show concrete progress, next steps, and risks across multiple lines. Persisted
event-revision coverage prevents activity arriving during the provider call from being skipped.

## Changes

### Evidence capture and compact reuse

- Added a summary-specific read-only snapshot that freezes the current event revision before any
  provider await and bounds every query, per-event payload, and token budget.
- Reused the Continuation Context message classifier, raw-user suffix selector, event normalizer,
  token estimator, validated checkpoint lookup, and checkpoint projector.
- Included recent user intent, an optional validated checkpoint projection, the previous display
  summary, and recent activity/tool results without running continuation fold, writing checkpoints,
  or leaving a hand-off spool.
- Hardened Claude summary calls to run from empty temporary directories without tools, MCP, or
  settings sources. Codex periodic evidence generation reuses compact's fail-closed isolation
  attestation and starts no turn until the model-visible built-in tool registry can be proven empty.

### Revision-safe persistence and scheduling

- Added v040 summary metadata for nullable source event revision, captured destructive-rebuild
  epoch, and generation source (`llm`, `assistant-fallback`, `stats-fallback`, or legacy).
- Restored the scheduler cursor from the latest persisted summary after restart, used revision deltas
  for triggering, and retained timestamp counting only for one legacy upgrade path.
- Stored the pre-await revision with every generated summary so later event inserts, updates, or
  deletes remain visible to the next scan; exact rebuild-epoch matching plus a rename boundary
  strictly beyond every moved revision forces an immediate fresh snapshot after rename/delete.
- Bounded assistant fallback lookup to the same captured revision and surfaced degraded generation
  sources in the renderer.

### Prompt, formatting, and UI

- Replaced the vague one-sentence/30-character prompt with an evidence-grounded one-to-four-line
  Chinese format: headline plus optional progress, next step, and risk lines.
- Formatted useful event types before applying the tail limit and added bounded tool results,
  terminal activity, and team-task state while continuing to exclude thinking/token noise. Tool
  interruption is distinct from completion, and only an explicit completed status claims success.
- Preserved compact multi-line model output, kept only the first line on session cards, and rendered
  full line breaks in current and historical Summary entries.
- Made the Codex fail-closed state explicit in the Intermittent Summaries settings hint.
- Documented the evidence sources and the strict separation from continuation checkpoint generation.

## Validation

- `pnpm typecheck` passed.
- Focused summary, adapter, migration, repository, rename, and renderer suite: 12 files / 64 tests
  passed after closing the final review findings.
- Full suite: 254 files / 2,431 tests passed.
- `pnpm build` and `pnpm logger:check` passed; diff, file-size, and review-expiry checks passed in the
  final validation gate.

## Do Not Split Protection

- None. Every changed production TypeScript/TSX file remains below the repository's 500-line limit.

## Notes

- The compact/Continuation Context checkpoint prompts and bundled Claude/Codex runtime instructions
  remain unchanged; this feature reuses only their lower-level read/projection primitives.
- Main-process and schema changes require a later safe application restart. The running Agent Deck
  app is not restarted or overwritten while it owns active sessions.
- A final read-only review found one unproven Codex isolation risk and two revision/status
  correctness gaps; all were fixed and the reviewer returned PASS with no remaining
  CRITICAL/HIGH/MEDIUM finding.
