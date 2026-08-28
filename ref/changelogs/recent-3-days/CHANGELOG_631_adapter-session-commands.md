---
changelog_id: 631
changed_at: 2026-08-27
---

# CHANGELOG_631_adapter-session-commands: Add native adapter slash commands

## Summary

Local and Remote message composers now discover the active adapter's slash commands, offer bounded
completion, and execute supported control commands through provider-native lifecycle operations.
Codex `/clear` and `/compact` are fully integrated without turning either command into a model
prompt.

## Changes

### Adapter command catalogs

- Add a shared, bounded command descriptor and optional adapter catalog API, with normalization for
  names, aliases, descriptions, argument hints, and total catalog size.
- Read Claude Code commands from the live SDK `supportedCommands()` API and retain explicit
  `/clear` and `/compact` lifecycle fallbacks.
- Consume Grok Build ACP `available_commands_update` notifications and expose the current runtime
  catalog.
- Advertise the Codex commands that Agent Deck can execute faithfully through app-server:
  `/clear` and `/compact`.

### Native command execution

- Route Codex `/compact` through `thread/compact/start`, translate its native turn lifecycle, queue
  ordinary input until compaction completes, and keep interrupt behavior scoped to that control
  turn.
- Route Codex `/clear` through a fresh native thread while preserving the stable Agent Deck session
  id, durable activity timeline, runtime options, and application ownership.
- Handle Claude conversation resets by updating only the native provider session id and resetting
  conversation-scoped usage and tool state.
- Reject command execution with attachments or during a handoff/worktree transition instead of
  accidentally sending command text as a prompt.

### Local and Remote composer parity

- Add Local IPC/preload command discovery and project the same catalog through Remote
  `session.input.capabilities`.
- Show slash suggestions in compact and expanded composers; clicking or pressing Tab completes the
  canonical command, and Enter submits an exact command.
- Keep unknown slash-prefixed text on the existing ordinary-message path.
- Advance the Remote protocol from 2.7 to 2.8 for the exact capability shape.
- Document the command behavior in the README.

## Validation

- Focused Vitest suite: 20 files / 93 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,015 files passed and 2 skipped; 6,327 tests passed and 3 skipped.
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

No exception is required. The largest changed production files remain at or below 500 lines; new
provider lifecycle logic and composer UI live in focused modules.

## Related plan

- `ref/plans/recent-3-days/PLAN_45_adapter-session-commands.md`
