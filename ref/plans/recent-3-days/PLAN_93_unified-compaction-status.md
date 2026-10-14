---
plan_id: 93
completed_at: 2026-10-14
status: completed
---

# Unified Compaction and Activity Status Presentation

## Goal

Implement the approved light compaction status strip across Claude, Codex, and Grok, and improve
adjacent activity-event presentation. Render command feedback as status rows while preserving
ordinary system messages as centered gray bubbles.

## Constraints and Decisions

- Keep one stable row for each compaction lifecycle and show only available evidence.
- Separate provider/session identities and consecutive operations, including partial histories.
- Preserve Grok ACP ID-addressed patch/chunk semantics before enabling the capability.
- Coalesce streamed summary snapshots while retaining lifecycle edges and their observed timing.
- Use neutral cancellation and collapsed details for activity and background-task rows.
- Treat structured session-command outcomes as command feedback; retain worktree system bubbles.
- Preserve ordinary system bubbles and specialized approval, message recovery, tool, and diff UI.
- Keep existing event kinds, database schema, and IPC surfaces.
- Preserve concurrent unrelated workspace changes and avoid live application process mutations.

## Completed Work

1. Added shared compaction evidence parsing and historical command-statistics support.
2. Implemented stable lifecycle projection and the approved status row with readable optional
   statistics and accessible detail disclosure.
3. Wired Claude status boundaries, Codex manual/native outcomes, and Grok ACP compaction updates.
4. Unified adjacent activity and background-task rows, cancellation colors, and outcome copy.
5. Preserved ordinary system-message bubbles, rendered structured command feedback as status
   rows, and verified the distinction in Browser.
6. Added protocol, lifecycle, persistence, store-update, and rendering regression coverage.

## Validation

- Typecheck and application build passed.
- Final release regression: 7,355 passed and 6 skipped; no failures.
- Final renderer-only adjustment: 140 targeted tests passed.
- Browser verified actual components with synthetic provider data, including narrow layouts,
  disclosure, command feedback, adjacent activity, and centered worktree system bubbles.
- No changed compaction implementation module requires a 500-line exception.

## Final Status

Implementation and source validation are complete. The user has requested commit, push, macOS
packaging, and local installation. Any shutdown of the running installed application requires
explicit target approval. Private preview, release progress, and validation scratch remain in
`.ref/` for local inspection.

See [CHANGELOG_681](../../changelogs/recent-3-days/CHANGELOG_681_unified-compaction-status.md).
