---
changelog_id: 350
changed_at: 2026-07-09
---

# CHANGELOG_350_codex-collaboration-observability: Complete Codex collaboration activity

## Summary

Codex collaboration activity now preserves the operation, model, reasoning effort, fork settings, targets, complete local call input, and tool output exposed by app-server. Agent rows, session summaries, and handoff context show the same useful details already available for Claude tools without fabricating a generic agent name.

## Changes

### Codex app-server translation

- Added a dedicated collaboration translator for normalized `collabAgentToolCall` items and raw `collaboration` function calls.
- Preserved complete raw call arguments and outputs, including encrypted-looking local transcript values, while retaining normalized thread state and failure metadata.
- Kept raw and normalized event ordering safe so an argument-only or successful raw event cannot erase a previously observed normalized failure.
- Removed the fabricated `codex-collab-agent` fallback and normalized app-server operation names such as `spawnAgent` and `wait`.

### Activity and summary presentation

- Added Agent activity details for operation, task/type, target, model, reasoning effort, target count, fork settings, service tier, path prefix, interrupt mode, and timeout.
- Kept complete Agent input and output available through the existing disclosure controls.
- Merged start- and completion-side Agent input metadata for stable activity rows.
- Included collaboration runtime parameters in periodic summaries and handoff event context.

## Validation

- Targeted translator, renderer, and summary tests passed.
- `pnpm typecheck`
- `pnpm test` — 191 files and 2124 tests passed.
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

None. New collaboration translation logic is isolated in `translate-collab.ts`; changed first-party source files remain at or below 500 lines.

## Notes

- Codex reasoning-summary HTML comments remain unchanged because they are provider output.
- Agent Deck still uses the repository-wide payload size limits when storing tool inputs and outputs.
- The running development app was not restarted because doing so would terminate the active Agent Deck session; restart it before interactive verification.
