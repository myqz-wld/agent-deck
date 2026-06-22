---
plan_id: diff-present-tool-and-walkthrough-skill-20260622
created_at: 2026-06-22
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 25ab300
---

# Diff Presentation Tool And Walkthrough Skill

## Goal

Add a user-facing diff presentation path to Agent Deck and Skill Market:

- Agent Deck MCP exposes `present_diff` for showing diff content to the user and waiting for confirmation or revision feedback.
- Agent Deck exposes the plan gate as `present_plan`, grouped with `present_diff` as user presentation rather than session orchestration.
- Skill Market publishes `diff-walkthrough` for Claude and Codex, covering PR walkthrough and merge-conflict walkthrough one fragment at a time.

## Scope

Implemented in Agent Deck:

- MCP tool registry/types/schema/handler for `present_diff`.
- Public tool rename for the plan presentation gate to `present_plan`.
- Pending diff presentation service, IPC/preload bridge, renderer store/selectors, PendingTab, ActivityFeed, TeamDetail pending counts, and pending row UI.
- Settings panel grouping, README, Claude/Codex runtime prompt assets, MCP counts, external-caller docs, and MCP PlantUML/index updates.

Implemented in Skill Market:

- `skills/claude/diff-walkthrough/SKILL.md`
- `skills/claude/diff-walkthrough/agents/openai.yaml`
- `skills/codex/diff-walkthrough/SKILL.md`
- `skills/codex/diff-walkthrough/agents/openai.yaml`
- `skills/INDEX.md` catalog rows

## Invariants

- `present_plan` / `present_diff` are user-presentation tools, not autonomous reviewer-agent workflows.
- Both presentation tools reject external callers without per-session identity.
- `present_diff` enforces `mode` / payload pairing: `mode: "pr"` requires `pr` and rejects `conflict`; `mode: "merge-conflict"` requires `conflict` and rejects `pr`.
- PR presentation supports two-column before/after input.
- Merge-conflict presentation supports ours/theirs/resolution, with optional base.
- `diff-walkthrough` processes exactly one fragment at a time, explains the code or conflict-resolution rationale, and waits for user confirmation before continuing.

## Validation

- `pnpm typecheck`
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts`
- Skill Market Ruby YAML/frontmatter and OpenAI metadata parse check
- Skill Market Claude/Codex skill and metadata alignment checks

## Notes

`skill-creator` quick validation was attempted, but the local Python environment lacks `PyYAML`, so Ruby YAML parsing and targeted behavior checks were used instead.
