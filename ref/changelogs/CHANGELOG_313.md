# CHANGELOG_313: Add MCP plan/diff presentation tools

## Summary

Agent Deck MCP now treats plan and diff user gates as presentation tools. The existing plan gate is exposed as `present_plan`, and the new `present_diff` tool presents PR-style before/after diffs or merge-conflict ours/theirs/resolution panes to the user before the agent continues.

Skill Market also gains a new user-facing `diff-walkthrough` skill for walking users through PR diffs and conflict resolutions one fragment at a time.

## Changes

- Added `present_diff` to the Agent Deck MCP registry and external-caller deny matrix.
- Renamed the public plan presentation tool from `request_plan_review` to `present_plan`.
- Added diff presentation schema, handler, pending service, IPC/preload wiring, renderer store state, pending selectors, PendingTab integration, ActivityFeed rendering, and TeamDetail pending counts.
- Added a pending diff presentation row with two-column PR display and three-pane merge-conflict display, plus confirmation and revision-feedback controls.
- Moved plan/diff presentation out of session orchestration in the settings panel and grouped `present_plan` / `present_diff` under user presentation.
- Updated Claude/Codex runtime prompt assets, README, MCP tool counts, external-caller docs, and MCP PlantUML/index records to 18 tools.
- Added Skill Market `diff-walkthrough` packages for Claude and Codex with aligned `SKILL.md` and OpenAI metadata.

## Validation

- `pnpm typecheck`
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts`
- Skill Market Ruby YAML/frontmatter and OpenAI metadata parse check
- Skill Market Claude/Codex skill and metadata alignment checks
