# CHANGELOG_331: Deepseek config home path

## Summary

Deepseek's local settings file now lives under the hyphenated Agent Deck home directory.

## Changes

- Changed the Deepseek Claude Code adapter settings path from `~/.agent_deck/.deepseek/settings.json` to `~/.agent-deck/.deepseek/settings.json`.
- Kept the path change direct: the adapter no longer reads or migrates the legacy underscore directory.
- Updated README and resources documentation to point at the new settings path.
- Added config tests for the new path and the lack of legacy-path fallback.

## Validation

- `pnpm exec vitest run src/main/adapters/deepseek-claude-code/__tests__/config.test.ts src/main/adapters/deepseek-claude-code/__tests__/summarise-events.test.ts`
- `pnpm typecheck`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
