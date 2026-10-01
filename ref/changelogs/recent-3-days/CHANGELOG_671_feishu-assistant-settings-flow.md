---
changelog_id: 671
changed_at: 2026-10-01
---

# Simplify Feishu assistant settings and creation

## Summary

Remote settings configure only the Feishu assistant. Work sessions choose their options during
creation and remember those choices independently of Desktop. Resolved defaults appear as actual
values, and asynchronous settings transitions retain complete forms with the shared 150 ms grace.

## Changes

- Remove the separate new-work editor. Preserve its stored selection for the existing creation
  paths and optional explicit configuration commands.
- Show effective thinking, approval, and sandbox defaults without extra follow-default choices.
  The Gateway selector identifies native configuration as a source and lists discovered Gateways.
  Reuse regular remote creation sandbox labels and descriptions. Displaying a default does not
  save an unedited override.
- Read assistant preferences and initial capabilities as one presentation operation. Keep drafts
  mounted during refresh and adapter/Gateway reads, block stale writes immediately, and reveal
  waiting feedback at 150 ms. Commit complete fast results directly. Preserve source and revision
  fences and failed-save recovery.
- Ask for an initial work adapter during the creation conversation and pass the choice to the
  existing creation tool, which already remembers it. Direct command recovery points to `/create`.
  Advance the shared assistant setup version to 3 so retained chats receive the new rule once.
- Clarify Desktop and Feishu documentation without changing their separate persistence scopes.

## Validation

- `pnpm typecheck` passed, including architecture checks and both TypeScript projects.
- Relevant Electron tests passed: 37 files, 260 tests across settings, the IM gateway, Feishu
  preference and work management, MCP work tools, and remote usage. The final settings presentation
  adjustment also passed its three files and 29 tests.
- Tests cover combined initial readiness, the 149/150 ms boundary, retained refresh drafts, blocked
  stale saves, adapter transitions, fast Gateway defaults, first work creation without a prior
  settings step, remembered choices, and retained assistant setup updates.
- SQLite native binding checksum remained unchanged by validation. `git diff --check` passed.
- The existing remote usage tests confirm reset routing and account-credit refresh; no real reset
  credit was consumed and no live remote deployment was performed.

## Prompt asset validation

User Custom Points: none.

The owner confirmed both the interaction model and the exact prompt edit through structured
questions. Only the creation rule and setup version in `src/gateways/im/conversation-prompt.ts`
changed. It is shared by Claude, Codex, and Grok; their bundled application conventions were checked
without edits. Native controls, ownership, independent work history, and retry boundaries remain
intact. No tool schema, catalog metadata, external link, or bundled resource reference changed.
The private seven-day inventory and asset hashes were refreshed; no approval gate was skipped.

## Do Not Split Protection

None. The editor is extracted into `FeishuPreferenceEditor.tsx`; changed source and test files
remain below 500 lines.

## Notes

Renderer changes use development HMR. The Feishu gateway prompt/recovery changes and Core recovery
message require a later remote release to affect the running deployment. Installed applications
and live services were preserved. See [PLAN_80](../../plans/recent-3-days/PLAN_80_feishu-assistant-settings-flow.md).
