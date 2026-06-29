# CHANGELOG_329

## Summary

Add a Deepseek v4-pro reviewer slot and make bundled simple/deep review workflows require an explicit two-reviewer selection.

## Changes

- Added bundled `reviewer-deepseek` under the Claude-family agent resource root, using `model: deepseek-v4-pro[1m]` and `effort: xhigh`.
- Updated `reviewer-claude` and `reviewer-codex` prompt assets so each reviewer works with the other selected reviewer instead of a fixed hard-coded counterpart.
- Updated bundled `simple-review` and `deep-review` skills to require exactly two confirmed reviewer slots selected from `reviewer-claude`, `reviewer-codex`, and `reviewer-deepseek`.
- Updated reviewer failure and recovery guidance so failed reviewers are respawned as the same selected slot, without silently swapping to an unselected slot.
- Extended runtime reviewer-name guards and tests so `reviewer-deepseek` is treated as a reviewer slot and Deepseek spawns resolve the Claude-family agent asset while keeping `deepseek-claude-code` as the target adapter.
- Updated bundled resource docs and README reviewer lists.

## Validation

- `git diff --check` passed.
- Paired Claude/Codex `simple-review` and `deep-review` skill files are byte-identical.
- Local Node validation passed for `reviewer-deepseek` frontmatter and `reviewer-codex.toml` model / effort / multiline closure.
- `pnpm vitest run src/main/claude-config/custom-agents.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts` passed: 23 tests.
- `pnpm typecheck` passed.
- No new Claude adapter sessions were started during lead validation after the user requested not to use the Claude adapter.

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
