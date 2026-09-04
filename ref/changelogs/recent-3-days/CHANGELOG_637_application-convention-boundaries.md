---
changelog_id: 637
changed_at: 2026-09-04
---

# CHANGELOG_637_application-convention-boundaries: Keep conventions task-focused and host-safe

## Summary

The bundled Claude, Codex, and Grok application conventions now describe only task-time behavior
and identify the Agent Deck host as live user-owned state. Provider-specific injection mechanics
remain documented for maintainers, while every project and runtime entry point requires explicit
user approval before Agent Deck process mutation.

## Changes

- Removed bundled-resource, per-session transport, native instruction-file loading, and local-path
  explanations from the three model-visible application-convention documents.
- Aligned their title and scope section while preserving each provider's native safety and
  instruction terminology.
- Simplified the Claude and Codex injected separators to a neutral application-conventions label.
- Corrected Claude maintainer comments to distinguish the preset system-prompt append from the
  separately loaded filesystem `CLAUDE.md` project context.
- Documented Codex `developerInstructions` as an app-owned field separate from the native
  `AGENTS.md` chain.
- Documented that Grok Build consumes `_meta.rules` while constructing a new native session and
  retains the persisted system prompt when loading an existing session.
- Added aligned host-runtime safety rules to the project `AGENTS.md` / `CLAUDE.md` entry points and
  all three bundled application conventions. A restart requirement, validation rule, or script
  side effect no longer counts as process-mutation permission.
- Replaced the unconditional main/preload restart recipe, including its port-wide kill and broad
  `pkill` commands, with a report-and-request approval boundary and exact-target requirement.
- Required agents to keep the local installer away from live Agent Deck instances; packaging may
  continue without installation while the app remains running.
- Added exact separator assertions for the Claude and Codex prompt builders.

## Validation

- Focused Claude, Codex, and Grok injection tests — 3 files and 6 tests passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 1,017 files and 6,345 tests passed; 2 files and 3 opt-in tests skipped.
- Runtime-prompt loading-term and host-process-safety audits plus `git diff --check` — passed.

## Do Not Split Protection

No exception is required. The largest touched production file, `node-asset-catalog.ts`, remains at
475 lines; this change replaces one string there and adds no responsibility.

## Notes

Runtime behavior is unchanged: Claude still uses the preset `systemPrompt.append`, Codex still uses
app-server `developerInstructions`, and Grok still receives the shared ACP session metadata. User,
project, and provider-native instruction loading remains owned by each provider. Existing process
and installer scripts are unchanged; the instruction boundary now prevents invoking their process
side effects without the required user approval.
