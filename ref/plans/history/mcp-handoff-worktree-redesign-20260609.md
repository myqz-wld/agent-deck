---
plan_id: "mcp-handoff-worktree-redesign-20260609"
created_at: "2026-06-09T12:38:00+08:00"
worktree_path: "/Users/wanglidong/Repository/agent-deck/.claude/worktrees/mcp-handoff-worktree-redesign-20260609"
status: "in_progress"
base_commit: "9427fb781dd176b85241bca60b559e1970999858"
base_branch: "main"
---

# Plan: MCP handoff and worktree redesign

## Goal

Redesign Agent Deck MCP session/worktree contracts so plan management is not a public MCP workflow. `hand_off_session` becomes a generic session baton that always closes the caller and transfers caller resources. Worktree tools become plan-free and branch-based.

## Non-Goals

- Do not add a new plan archive replacement tool.
- Do not make Agent Deck baseline depend on an external user skill.
- Do not keep public `archive_plan` or `shutdown_baton_teammates` tool contracts.
- Do not add optional resource-transfer switches to `hand_off_session`.

## Invariants

1. `hand_off_session` starts one successor session, transfers caller resources, then closes caller only when mandatory transfer succeeds.
2. `hand_off_session` does not accept `planId`, `planFilePath`, `phaseLabel`, `teamName`, `archiveCaller`, `closeCaller`, `adoptTeammates`, or task transfer policy switches.
3. `spawn_session` remains the independent-session tool. Long context can be put in `/tmp/...` and referenced from the prompt for both `spawn_session` and `hand_off_session`.
4. `archive_plan` and `shutdown_baton_teammates` are removed from the public MCP tool registry and durable prompt assets.
5. `enter_worktree` requires a named local `baseBranch` and creates a work branch from that branch's current code version.
6. `exit_worktree` cleans the worktree directory and clears the marker. It protects changes by rejecting dirty worktrees and by keeping the branch by default.
7. Claude/Codex prompt assets stay behaviorally aligned while preserving adapter-specific mechanics.

## Design Decisions

- `hand_off_session.prompt` is required. Plan paths and next actions live in prompt text.
- `hand_off_session` transfers cwd/worktree marker, personal tasks, team memberships, team-bound task visibility, and lead roles to the new session. Mandatory transfer failure returns an error, keeps the caller active, and rolls back already-applied transfer substeps.
- `enter_worktree` no longer reads plan frontmatter. It resolves `baseBranch` through `refs/heads/<baseBranch>` and returns the resolved commit.
- `exit_worktree` keeps the work branch by default. Branch deletion is opt-in and guarded by dirty/unmerged checks.
- Public plan archiving becomes project/skill orchestration with normal filesystem/git commands, not Agent Deck MCP policy.

## Implementation Checklist

- [x] Remove public `archive_plan` and `shutdown_baton_teammates` registration and prompt references.
- [x] Simplify `hand_off_session` schema and handler to session-only baton.
- [x] Implement unconditional caller resource transfer for tasks, teams, and cwd marker.
- [x] Redesign `enter_worktree` schema/handler around `baseBranch`, optional `workBranch`, and optional path/root.
- [x] Redesign `exit_worktree` schema/handler to remove worktree content safely and keep branches by default.
- [x] Update Claude/Codex baseline prompt assets.
- [x] Update flow and architecture PlantUML SSOT files and indexes.
- [x] Update tests and validation.

## Validation

- `pnpm typecheck`
- `pnpm build`
- Targeted vitest suites for MCP schemas/handlers, handoff, worktree, and spoofing permissions.
- Prompt asset self-check for stale `archive_plan`, plan-driven handoff, `.claude/worktrees`, and removed option names in live assets.

## Known Risks

- Removing public tools is a breaking change for live sessions that still call old tool names.
- Resource transfer must preserve task and team permissions without creating dual-lead windows.
- `exit_worktree` must not lose commits or dirty files by default.
- Durable diagrams currently model archive-plan and plan-driven handoff; they must be archived or rewritten.

## Current Progress

- User decisions captured.
- Worktree created from `main` at `9427fb7`.
- Public MCP registry exposes 16 tools; retired archive/cleanup names remain only as guard/type compatibility keys.
- `hand_off_session` is prompt-only and closes the caller only after resource transfer succeeds.
- Worktree tools are branch-based and plan-free.
- Claude/Codex baseline prompt assets and PlantUML SSOT files are updated.
- Round 2 HIGH fixed: multi-team partial transfer and later task/team failures roll back already-applied resource transfer state before the handler reports failure.
- Validation passed: `pnpm typecheck`, targeted Vitest 91 passed, `git diff --check`, `pnpm build`.
- Review gate passed: reviewer-codex Round 3 PASS and reviewer-claude Round 3 PASS with no CRITICAL/HIGH/MEDIUM findings.

## Next-Session First Action

Prepare user-facing merge/review notes from this plan, `CHANGELOG_233.md`, and the final validation record.
