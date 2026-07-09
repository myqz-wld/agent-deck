---
plan_id: reviewer-model-selection-20260629
created_at: 2026-06-29
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 353492797ed5b03c653f9ba34a30b0b2b826ac30
base_branch: main
---

# Reviewer Model Selection

## Goal And Invariants

Add a Deepseek v4-pro reviewer option named `reviewer-deepseek` and update the bundled `simple-review` / `deep-review` skills so the lead confirms exactly two heterogeneous reviewer model slots before spawning reviewers.

Required invariants:

- Keep review workflows to exactly two selected reviewers per run.
- Keep selected reviewers heterogeneous by adapter / provider slot.
- Preserve existing turn-boundary rules: after spawning reviewers or sending follow-up review prompts, end the current turn and wait for Agent Deck message injection.
- Do not add review-skill rules that explicitly set `permissionMode`, `claudeCodeSandbox`, or `codexSandbox`; callers must omit those unless the user explicitly requests an override.
- Do not change global Deepseek settings or the open custom-model-id behavior of `spawn_session.model`.

## Confirmed Scope

User approved this scope after renaming the proposed Deepseek reviewer from `reviewer-dpv4-pro` to `reviewer-deepseek`.

Editable prompt assets:

- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`
- `resources/claude-config/agent-deck-plugin/agents/reviewer-deepseek.md` (new)
- `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml`
- `resources/{claude,codex}-config/agent-deck-plugin/skills/simple-review/SKILL.md`
- `resources/{claude,codex}-config/agent-deck-plugin/skills/deep-review/SKILL.md`
- `resources/claude-config/CLAUDE.md`
- `resources/codex-config/CODEX_AGENTS.md`
- `resources/README.md`
- `README.md` only if user-visible bundled reviewer docs need updating

Likely source/test scope:

- `src/main/adapters/options-builder.ts`
- `src/main/claude-config/custom-agents.ts`
- `src/main/claude-config/custom-agents.test.ts`
- `src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`
- possibly `src/main/agent-deck-mcp/__tests__/tools.test.ts`

## Design Decisions

Selectable reviewer slots:

- `reviewer-claude`: `adapter: "claude-code"`, `agentName: "reviewer-claude"`, current `opus` frontmatter.
- `reviewer-codex`: `adapter: "codex-cli"`, `agentName: "reviewer-codex"`, current `gpt-5.5` TOML.
- `reviewer-deepseek`: `adapter: "deepseek-claude-code"`, `agentName: "reviewer-deepseek"`, frontmatter model `deepseek-v4-pro[1m]`.

`simple-review` and `deep-review` must ask for or record the two-slot selection before spawn. If no selection is already provided, the workflow stops for user confirmation instead of silently choosing.

Fallbacks respawn the failed selected reviewer slot on the same adapter/agent. They never replace it with a different slot or duplicate the surviving slot.

## Task Breakdown

| Task | Status | Validation |
|---|---|---|
| Confirm scope and write plan | completed | Plan approval received; this file created |
| Prompt-asset inventory and backup | completed | Inventory JSON and backup manifest under `.prompt-asset-improver/local/` |
| Focused prompt edit review | completed | Claude editor session `8a6658d5-965b-4377-838e-cf5bbc9ed85e` closed after user instruction; Codex editor session `019f1162-c84e-79f3-bed6-a03dcef83043` completed prompt edits |
| Implement source and prompt assets | completed | Added `reviewer-deepseek`; updated reviewer selection prompts, runtime guards, spawn routing tests, and docs |
| Validate and document | completed | Frontmatter/TOML checks, paired skill diff checks, targeted vitest, `pnpm typecheck`, changelog/index update |

## Validation Plan

- Prompt assets:
  - Re-read changed section openings and descriptions.
  - Check local links/resource paths.
  - Validate Markdown frontmatter and TOML.
  - Check Claude/Codex same-name skill behavioral alignment.
- Source/tests:
  - `pnpm vitest run src/main/claude-config/custom-agents.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`
  - Add `src/main/agent-deck-mcp/__tests__/tools.test.ts` if spawn defaults or model routing behavior changes there.
  - `pnpm typecheck`

## Current Progress

Read project workflow, prompt-asset-improver skill, complex-plan workflow, bundled reviewer assets, `spawn_session` model alias handling, custom-agent resolution, and related changelog/review records. User approved the scoped plan with `reviewer-deepseek` as the Deepseek reviewer name.

Prompt-asset inventory written to `/Users/wanglidong/Repository/agent-deck/.prompt-asset-improver/local/inventory.json`.

Prompt-asset backup written to `/Users/wanglidong/Repository/agent-deck/.prompt-asset-improver/local/backups/20260629T031459Z`; 10 existing files were backed up, and new `reviewer-deepseek.md` was inventory-only. Backup pruning removed old manifest-backed directories `20260611T102250Z`, `20260612T064813Z`, `20260612T070022Z`, `20260613T150331Z`, `20260613T152206Z`, and `20260613T152344Z`.

Focused prompt editor initially dispatched in Agent Deck team `reviewer-model-selection`:

- session: `8a6658d5-965b-4377-838e-cf5bbc9ed85e`
- spawn prompt message: `ff9d5261-6d14-403c-a15a-762b9cbba50f`
- allowed write set: prompt assets listed in Confirmed Scope only

After dispatch, the user instructed not to use the Claude adapter now. The Claude focused editor session was shut down before relying on its work. Future auxiliary sessions for this task must avoid `claude-code`.

Codex-only focused prompt editor dispatched in the same Agent Deck team:

- session: `019f1162-c84e-79f3-bed6-a03dcef83043`
- spawn prompt message: `3861f88e-c1a4-4a7c-88eb-55dd617dcfb9`
- adapter: `codex-cli`

Codex editor reported prompt-asset edits and local prompt-asset checks. The lead then added source/test support:

- `src/main/claude-config/custom-agents.ts` now treats `reviewer-deepseek` as a Claude-family reviewer slot for messaging-tool drift protection.
- `src/main/adapters/options-builder.ts` now includes `reviewer-deepseek` in `REVIEWER_AGENT_NAMES`.
- Spawn routing tests now cover `deepseek-claude-code` resolving `reviewer-deepseek` through the Claude-family asset root while preserving the target adapter and `deepseek-v4-pro[1m]` model.
- Changelog record added at `ref/changelogs/CHANGELOG_329.md`.

Validation completed:

- `git diff --check`
- paired skill byte-identity check for Claude/Codex `simple-review` and `deep-review`
- local Node validation for `reviewer-deepseek` frontmatter and `reviewer-codex.toml`
- `pnpm vitest run src/main/claude-config/custom-agents.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts`
- `pnpm typecheck`

Closeout completed:

- reviewer changes committed as `360b28b Add Deepseek reviewer slot selection`
- pushed to `origin/main`
- final plan archived to `ref/plans/reviewer-model-selection-20260629.md`

## Risks

- `reviewer-deepseek` reuses Claude-family agent assets through the Deepseek adapter; messaging tools must be available just like `reviewer-claude`.
- Review skills currently assume a fixed `reviewer-claude` + `reviewer-codex` pair; all failure, rebuttal, coverage, and final-report wording must become selected-pair aware without weakening the two-reviewer gate.
- Prompt-asset edits are substantive; focused editing agent review is required before local content edits.

## Next-Session First Action

No next-session action remains unless the user requests follow-up review or packaging.
