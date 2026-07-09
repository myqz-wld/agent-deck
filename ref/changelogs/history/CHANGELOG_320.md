# CHANGELOG_320: Diff walkthrough presentation defaults

Updated the durable prompt and MCP metadata that steer step-by-step diff walkthroughs.

## Changes

- Expanded the Agent Deck MCP `present_diff` self-description into scanable guidance for per-fragment walkthrough use.
- Clarified `present_diff` schema descriptions for PR before/after payloads, merge-conflict panes, `unifiedDiff` as supporting context, and walkthrough annotations.
- Updated Skill Market `diff-walkthrough` Claude/Codex skills so interactive presentation is the default path and inline text is fallback only when no capable tool exists.
- Added capability-based presentation-tool identification, PR/two-column and conflict/three-way shape mapping, and approve/revise/stop/timeout loop binding to the Skill Market skills.
- Bumped Skill Market `diff-walkthrough` Claude/Codex catalog versions to `0.0.2`.

## Validation

- `pnpm typecheck`
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts`
- Skill Market Ruby frontmatter/YAML parse for the changed skills and metadata.
- Skill Market Claude/Codex skill identity check, concrete-tool-name portability scan, catalog-version check, and `git diff --check`.
