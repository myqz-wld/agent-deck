# CHANGELOG_333: Deepseek reviewer max effort

## Summary

`reviewer-deepseek` now requests the maximum Claude-family effort level when spawned.

## Changes

- Changed bundled `reviewer-deepseek` frontmatter from `effort: xhigh` to `effort: max`.
- Updated Claude-family custom-agent and MCP spawn routing tests so Deepseek reviewer spawns preserve `max`.
- Left `reviewer-claude` and `reviewer-codex` effort settings unchanged.

## Validation

- Frontmatter self-check confirmed `reviewer-deepseek` keeps `model: deepseek-v4-pro[1m]` and now uses `effort: max`.
- `pnpm exec vitest run src/main/claude-config/custom-agents.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`
- `pnpm typecheck`
- `git diff --check`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
