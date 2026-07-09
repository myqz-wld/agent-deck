---
plan_id: diff-panel-sdk-upgrade-20260629
created_at: 2026-06-29
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 0a8f715593b0b7b821d4ce8c419fe5cf0f2668e1
---

# Diff Panel Bottom Padding and SDK Upgrade

## Goal and invariants

- Fix intermittent diff panel bottom clipping so the final visible line can be scrolled fully above panel borders, scrollbars, and action controls.
- Keep the fix shared across normal SessionDetail diffs and MCP `present_diff` panels.
- Upgrade directly related Claude/Codex runtime dependencies only:
  - `@anthropic-ai/claude-agent-sdk`: npm latest verified as `0.3.195`.
  - `@anthropic-ai/sdk`: npm latest verified as `0.106.0`.
  - `@openai/codex`: npm latest verified as `0.142.3`.
- Leave unrelated dependencies unchanged. `@modelcontextprotocol/sdk` latest remains `1.29.0`.

## Design decisions

- Add bottom scroll padding at the renderer diff layer instead of adding outer panel margins only, because the clipped line can appear inside Monaco, full-file diff panes, raw patch panes, or annotation/conflict panes.
- Preserve the existing compact `present_diff` layout height, but make its fixed-height container a complete flex/min-size chain so the child renderer receives a stable height.
- Use package-manager lockfile updates instead of manual lockfile editing for SDK/native package integrity.

## Task breakdown

| Task | Owner | Status | Validation |
|---|---|---|---|
| Inspect diff panel rendering and dependency declarations | Codex | completed | Source/history read |
| Write scoped plan record | Codex | completed | Draft created under `.ref/plans/` |
| Implement shared bottom-padding/height fix | Codex | completed | Renderer tests passed |
| Upgrade Claude/Codex packages and lockfile | Codex | completed | Version checks passed |
| Update changelog/review/docs as required | Codex | completed | CHANGELOG_332 / REVIEW_141 / plan index |
| Run validation | Codex | completed | typecheck, build, focused tests, diff check |

## Progress, validation, and risks

- Repository instructions, Codex/Claude app convention assets, relevant plan/changelog/review indexes, and related diff/dependency history were read.
- npm registry check on 2026-06-29 returned:
  - `@anthropic-ai/claude-agent-sdk` `0.3.195`.
  - `@anthropic-ai/sdk` `0.106.0`.
  - `@openai/codex` `0.142.3`.
  - `@modelcontextprotocol/sdk` `1.29.0`.
- The diff fix landed in shared renderer code, not just one UI entry point.
- `pnpm update @anthropic-ai/claude-agent-sdk@0.3.195 @anthropic-ai/sdk@0.106.0 @openai/codex@0.142.3` updated package specs and platform/native lockfile entries.
- Validation passed:
  - `pnpm exec vitest run src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx src/renderer/components/pending-rows/diff-review-presentation.test.tsx`
  - `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts`
  - Installed package and Codex CLI version checks.
  - npm latest checks for the scoped packages.
  - `pnpm typecheck`
  - `pnpm build`
  - `git diff --check`
- Residual risk: this session did not run packaged app install validation.
- Scope note: Deepseek settings-path changes committed as `0a8f715` are outside this plan. The archived base commit records the final base after that independent commit landed.

## Next-session first action

No follow-up action is required for this plan. If packaging validation is desired later, run the repository packaging/install workflow from `CLAUDE.md`.
