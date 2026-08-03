---
changelog_id: 415
changed_at: 2026-07-30
---

# CHANGELOG_415_hook-event-lifecycle-completeness: Preserve hook lifecycles

## Summary

Capture compaction and subagent lifecycle hooks consistently across Claude Code, Codex CLI, and
Grok Build. Claude display-only message fragments are now retained separately from canonical
assistant messages, while incomplete Codex tool lifecycles are closed conservatively at terminal
boundaries.

## Changes

### Cross-adapter hook contract

- Add first-class normalized events for context compaction start/end, subagent start/end, and
  display-only assistant message fragments.
- Install and route `PreCompact`, `SubagentStart`, and `SubagentStop` for all three adapters.
- Install and route Claude Code `MessageDisplay`, preserving its message id, delta index, final
  marker, and display delta without duplicating the authoritative final assistant message.
- Preserve provider-specific lifecycle metadata such as turn ids, subagent ids/types, transcript
  paths, compaction triggers/summaries, and stop details.

### Codex terminal correctness

- Mark every received Codex `PostToolUse` as `completed`; a non-zero command exit code remains a
  completed tool response and does not mean the hook lifecycle failed.
- Query persisted Codex tool starts that have no matching end event when `Stop` or `SessionEnd`
  arrives, then synthesize an `aborted` terminal event with an explicit
  `turn-ended-without-post-tool-use` reason.
- Clear stale external-terminal permission waiting state at both turn and session terminal
  boundaries.

### Rendering and downstream evidence

- Render the new lifecycle kinds in activity, session-card, and team-event summaries with stable
  keys and localized status labels.
- Keep `MessageDisplay` fragments out of continuation, checkpoint-backlog thresholds, and
  periodic-summary evidence so streaming display batches cannot crowd out or duplicate canonical
  conversation content. The checkpoint source guard now also ignores the existing excluded
  thinking and token-usage telemetry.
- Preserve compaction and subagent lifecycle signals in periodic summaries.

### Regression coverage

- Keep installer and route contracts locked together for each adapter.
- Cover all new translators, Codex terminal reconciliation ordering, SQLite unmatched-tool
  selection, state cleanup, event rendering, summary filtering, and app-server compaction parity.

## Validation

- Focused hook/state/store tests: 94 passed, 1 skipped under the plain Node ABI; the skipped SQLite
  case passed under the Electron full suite.
- `pnpm typecheck`
- `pnpm test` (473 files passed, 1 skipped; 4,036 tests passed, 1 skipped)
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Do Not Split Protection

All changed production files remain at or below 500 lines. The unmatched-tool query lives in
`open-tool-use-repo.ts` rather than extending `event-repo.ts`, which is already exactly 500 lines.
The pre-existing Codex app-server translation test remains above the guardrail because this change
updates its existing compaction assertion in place; split that shared-harness suite when its next
structural test reorganization is undertaken.

## Notes

- No provider-version detection was added. A runtime that does not support a configured hook simply
  produces no event for it.
- No event pagination behavior changed.
- No raw transcript or hook-envelope sidecar was introduced.
