---
changelog_id: 368
changed_at: 2026-07-15
---

# CHANGELOG_368_settings-panel-alignment: Align settings copy and controls

## Summary

The settings panel now explains continuation context and intermittent summaries by their actual use
cases, keeps model guidance focused on blank-model behavior, and uses one sandbox vocabulary across
Claude and Codex. General settings also expose a guarded reset-to-default action.

## Changes

### Session settings

- Identified Continuation Context as the hand-off and missing-native-history recovery mechanism.
- Identified intermittent summaries as session-card and Summary-view content, separate from hand-off
  and recovery.
- Reduced checkpoint cadence and raw-retention help to field-specific descriptions.
- Gave Claude, Deepseek, and Codex model fields the same one-line blank-model template and removed
  duplicated Thinking-level guidance already visible in the controls.
- Kept the existing 1–10 concurrent-summary control and added scheduler regression coverage proving
  that two sessions run concurrently while later sessions wait for a slot.

### Shared settings surfaces

- Removed the keyboard-shortcut block from the launch-at-login section.
- Centralized sandbox options so Settings, new-session dialogs, recovery dialogs, and session detail
  all show Read Only / Workspace Write / Full Access in the same order. Provider-specific security
  differences remain in option titles and section descriptions.
- Replaced separate Claude Code and Codex CLI help prose with one Runtime Configuration / Terminal
  Integration / In-App Features template.
- Added a confirmed “Reset to default configuration” action at the bottom of General. It resets all
  configurable preferences while preserving installation authentication tokens and installed Hooks.

## Validation

- `pnpm typecheck` passed.
- Focused renderer and summarizer suite: 6 files / 17 tests passed.
- Full suite: 310 files / 2,837 tests passed; one credentialed live smoke remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- In-app browser visual QA was unavailable because the browser runtime failed to initialize after a
  clean reconnect; component-level DOM interaction tests cover the changed controls and copy. The
  out-of-scope Agent Deck runtime defect is tracked as issue
  `6fdcbc56-e2c6-46b1-9ecb-eecb3b76a382`.

## Do Not Split Protection

None. Every changed production TypeScript / TSX file remains below 500 lines.
