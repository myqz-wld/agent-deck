---
changelog_id: 356
changed_at: 2026-07-10
---

# CHANGELOG_356_codex-max-thinking: Restore Codex MAX thinking

## Summary

Codex `max` is available again anywhere Agent Deck already accepts a Codex thinking level, including periodic summaries, Hand-off brief generation, and `spawn_session`. The settings UI now matches the existing shared type, app-server passthrough, MCP schema, bundled runtime prompts, and README contracts.

## Changes

### Summary and Hand-off settings

- Restored `MAX` to both Codex thinking selectors, alongside `minimal`, `low`, `medium`, `high`, `xhigh`, and `ultra`.
- Preserved `max` when switching a settings row from Claude or Deepseek to Codex instead of coercing it to `xhigh`.
- Removed the startup migration that rewrote persisted Codex summary and Hand-off `max` values to `xhigh`.
- Kept the periodic-summary default at `low` and the Hand-off brief default at `medium`; this change restores an explicit option without increasing default cost or latency.

### Runtime and MCP regression coverage

- Locked `spawn_session({ adapter: 'codex-cli', thinking: 'max' })` through the MCP handler into the spawned session's `modelReasoningEffort`.
- Locked `summaryReasoning=max` and `handOffReasoning=max` from settings through the two Codex oneshot runners into app-server thread options.
- Preserved existing `ultra` coverage and all adapter-specific validation boundaries.

## Compatibility Boundary

Settings that an earlier version already changed from `max` to `xhigh` remain `xhigh`. Agent Deck cannot distinguish those values from an intentional user selection, so automatically promoting every stored `xhigh` value would overwrite valid preferences. Users who want `max` can select it again in the restored dropdown.

This change does not add model or thinking parameters to MCP `hand_off_session`, and it does not change successor-session inheritance. It only restores `max` for the existing Hand-off brief generation setting and other established Codex thinking inputs.

## Validation

- Focused settings, spawn, and Codex oneshot suite: 4 files and 113 tests passed.
- `pnpm typecheck`
- `pnpm test` — 205 files and 2248 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Do Not Split Protection

No changed source file crosses the 500-line guardrail because of this patch. Existing large test and store files receive only localized regression or migration-removal edits; splitting them would be unrelated to restoring the shared thinking option.

## Notes

- `README.md`, the paired bundled Claude/Codex runtime prompts, the shared Codex thinking-level type, the MCP spawn schema/handler, custom-agent parsing, and Codex oneshot runtime already included `max`; they were verified and intentionally left unchanged.
- `CHANGELOG_354` and `REVIEW_145` remain unchanged as historical records of the superseded selector decision.
- The development and installed applications were not restarted at the user's request. The running UI remains unchanged; the restored selector is present in source/build output and appears on the next development launch or after packaging and installing the updated application.
