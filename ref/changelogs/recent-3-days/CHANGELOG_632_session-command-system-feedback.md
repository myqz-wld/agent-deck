---
changelog_id: 632
changed_at: 2026-08-27
---

# CHANGELOG_632_session-command-system-feedback: Show final silent-command status

## Summary

Provider-native session commands that do not produce a model reply now finish with one compact
system message in the session timeline, matching the presentation used for completed worktree
transitions. Commands that produce an assistant reply keep that reply without redundant feedback.

## Changes

- Emit one centered system message after Codex `/clear` completes, while retaining the stable Agent
  Deck session and prior timeline.
- Emit one error-styled system message when Codex cannot create the replacement native thread, then
  preserve the existing caller-visible failure.
- Present Claude's successful native conversation reset as the same system-message type instead of
  an assistant reply.
- Present successful and failed Codex manual compaction as one final system message while retaining
  token and context accounting; suppress its intermediate compaction and generic turn rows.
- Present Claude compaction boundaries and failures as final system messages instead of assistant
  replies.
- Resolve Grok command invocations from its live runtime catalog, including aliases and inline
  arguments, so catalog changes do not require a hard-coded silent-command list.
- For Grok commands, retain the normal assistant reply when one is emitted; otherwise hide the
  generic terminal row and emit one final system completion or failure.
- Do not add a start row, tool card, or redundant status for commands that naturally receive a model
  response.
- Document the final-only command feedback rule in the README.

## Validation

- Focused Vitest suite: 8 files / 46 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,016 files passed and 2 skipped; 6,334 tests passed and 3 skipped.
- `pnpm postinstall`
- `pnpm build`
- `git diff --check`
- One-off live Grok ACP acceptance with `gpt-56-sol`: `/compact` produced no assistant message and
  exactly one final system completion; `/session-info` produced its assistant response and no
  command-status message. Grok 1.0.6 did not advertise `/clear` in its runtime command catalog.

## Do Not Split Protection

No exception is required. The change reuses the existing compact system-message renderer and keeps
provider lifecycle changes within their focused reset controllers.

## Related change

- `ref/changelogs/recent-3-days/CHANGELOG_631_adapter-session-commands.md`
