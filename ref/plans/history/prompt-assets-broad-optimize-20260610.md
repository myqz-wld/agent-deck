---
plan_id: prompt-assets-broad-optimize-20260610
created_at: 2026-06-10
status: completed
base_branch: main
base_commit: c056bbf
worktree_path: null
---

# Plan: Broad In-App Prompt Asset Optimization

## Goal

Optimize Agent Deck's in-app prompt assets so durable instructions stay executable, current, scoped, and paired across Claude/Codex surfaces without weakening runtime safety, tool contracts, reviewer discipline, or handoff behavior.

## Confirmed Scope

User confirmed the expanded scope on 2026-06-10:

- Root prompt/documentation assets: `README.md`, `CLAUDE.md`, `AGENTS.md`.
- Resource documentation: `resources/README.md`.
- Bundled runtime prompt assets under `resources/claude-config/` and `resources/codex-config/`.
- `src/main/**` prompt builders, summarizer prompts, resume-history prompt text, teammate context blocks, and Agent Deck MCP tool/schema descriptions.

Excluded unless explicitly pulled in by validation:

- `ref/**` history/review/changelog records, except this plan.
- Tests, unless prompt text changes require fixture or snapshot updates.
- Renderer copy and UI text that is not injected into an AI model.

## Invariants

- Agent Deck bundled behavior remains self-contained in app resources; runtime assets must not depend on external user skills, local repository history, or current-project maintenance formats.
- Claude and Codex paired assets keep protocol semantics aligned while preserving adapter-specific mechanics.
- MCP descriptions keep exact caller-visible contracts: when to call, required parameters, permission boundary, and errors that change the caller's next step.
- Prompt builders continue treating conversation/activity history as read-only logs and preserve prompt-injection defenses.
- No low-value slimming may remove safety boundaries, wait-boundary rules, task/message/worktree contracts, issue reporting constraints, or validation gates.

## Active Custom Points

- 2026-06-09, user feedback, scope `resources/` prompt assets: Do not mention migrated asset names or current-repository maintenance formats in resource assets. These assets are read by other and future projects, so keep them focused on runtime resource layout, loading behavior, and paired-resource boundaries.

## Candidate Asset Groups

1. Root and resource docs:
   - `README.md`
   - `CLAUDE.md`
   - `AGENTS.md`
   - `resources/README.md`
2. Bundled runtime baselines and plugin assets:
   - `resources/claude-config/CLAUDE.md`
   - `resources/codex-config/CODEX_AGENTS.md`
   - `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`
   - `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`
   - all bundled `SKILL.md` files in both config roots.
3. Runtime prompt builders and context blocks:
   - `src/main/session/oneshot-llm/build-prompt.ts`
   - `src/main/session/resume-history/inject-history.ts`
   - `src/main/agent-deck-mcp/tools/handlers/lead-context-block.ts`
   - `src/main/agent-deck-mcp/tools/handlers/adopted-teams-context-block.ts`
   - `src/main/adapters/claude-code/sdk-bridge/permission-responder.ts`
   - `src/shared/restart-prompts.ts`
   - `src/shared/hand-off-headers.ts`
4. MCP tool/schema descriptions:
   - `src/main/agent-deck-mcp/tools/index.ts`
   - `src/main/agent-deck-mcp/tools/schemas.ts`

Inventory refresh may mark additional `src/main/**` prompt strings as confirmed if they are directly injected into SDK/model/tool instructions, or exclude candidates that are only comments/user-facing UI text.

## Checklist

- [x] Confirm expanded scope with user.
- [x] Refresh `.prompt-asset-improver/local/inventory.json` for the expanded scope.
- [x] Back up every editable prompt asset before edits.
- [x] Dispatch focused editing agents by asset group before local content edits.
- [x] Inspect agent diffs, resolve conflicts, and apply accepted edits.
- [x] Check paired Claude/Codex assets for semantic drift.
- [x] Check changed assets for dead local links and resource paths.
- [x] Validate Markdown/frontmatter/JSON/YAML/TypeScript and run targeted tests.
- [x] Run independent prompt-asset review and adjudicate findings.
- [x] Run final `pnpm typecheck`; run `pnpm build` if source prompt/schema edits are material.
- [x] Update task status and final report with backup/restore details.

## Validation Plan

- Markdown/frontmatter parse checks for root/resource/agent/skill assets.
- TypeScript validation for changed `src/main/**` files.
- Targeted tests for prompt builders and MCP tool descriptions when impacted, likely:
  - `pnpm vitest run src/main/session/oneshot-llm/__tests__/build-prompt.test.ts`
  - `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm typecheck`.
- `pnpm build` if source prompt/schema edits are non-trivial.

## Risks

- Broad slimming can accidentally remove runtime contracts that only app-injected sessions see.
- Paired Claude/Codex assets can drift if edited asymmetrically.
- MCP schema descriptions are part of the tool-use contract; wording changes can alter model behavior even without TypeScript logic changes.
- Root docs and bundled runtime assets have different audiences; resource assets must not inherit repository-maintenance-only language.

## Progress

2026-06-10:

- User expanded scope to include root docs, `resources/README.md`, and `src/main/**` prompt/tool-description assets.
- Confirmed git worktree is clean.
- Confirmed no pending `.prompt-asset-improver/local/skill-improvements.md` queue exists.
- Identified primary source candidates: `build-prompt.ts`, `inject-history.ts`, Agent Deck MCP `index.ts`/`schemas.ts`, context-block builders, and `restart-prompts.ts`.
- Refreshed local inventory with 23 confirmed assets.
- Created backup `20260610T044741Z` at `/Users/wanglidong/Repository/agent-deck/.prompt-asset-improver/local/backups/20260610T044741Z`; no old backups pruned.
- Dispatched focused editing agents:
  - Batch A root/resource docs: session `4803d237-3dc3-4597-b886-9c229dd9a730`, anchor `c526564d-c0a3-4c33-a9a5-27ff25fb9be5`.
  - Batch B runtime paired assets: session `019eafdc-cb59-7480-86c3-5dcc6f574751`, anchor `f788cac3-531b-4c3a-9506-2f060f942138`.
  - Batch C source prompt builders: session `5a91f3dd-ed3b-4ec9-b10c-e0f39ea835a1`, anchor `592c8140-1724-45bb-91f7-045107b682e7`.
  - Batch D MCP descriptions: session `019eafdc-d324-7721-bb62-87c280a27346`, anchor `4e59cd81-0f5c-4925-9b41-7530d72acf0a`.
- Batch A returned via message `e9526b1c-2fb0-475a-8642-f4155e065e7f` from session `4803d237-3dc3-4597-b886-9c229dd9a730`. Lead inspected `README.md` and `resources/README.md` diff and accepted the changes: removal of current-repository/internal review wording only, no runtime contract changes.
- Batch B returned via message `838d8292-7f1b-430c-89ca-38a914225d9d` from session `019eafdc-cb59-7480-86c3-5dcc6f574751`. Lead inspected runtime asset diffs, reran UTF-8 YAML frontmatter parsing, checked paired skill diffs, and accepted the changes. `hello-from-deck` remained unchanged.
- Batch D returned via message `aaeb150e-f263-4326-bac0-6681bacc22f4` from session `019eafdc-d324-7721-bb62-87c280a27346`. Lead inspected MCP description diffs and accepted them after two accuracy corrections: `send_message` now says non-closed session rather than live session, and `exit_worktree` now reflects explicit path behavior when no marker exists. `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` passed 68 tests after the corrections.
- Batch C returned via message `d7528649-c897-46cf-b62f-c45b7ca7069e` from session `5a91f3dd-ed3b-4ec9-b10c-e0f39ea835a1`. Lead inspected `src/main/session/resume-history/inject-history.ts` and accepted the single `SUMMARY_HEADER` wording change. Local validation passed: `pnpm vitest run src/main/session/oneshot-llm/__tests__/build-prompt.test.ts src/main/session/resume-history/__tests__/inject-history.test.ts` passed 29 tests; `pnpm vitest run src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts` passed 39 tests.
- Final local validation before review: `git diff --check` passed, UTF-8 YAML frontmatter parse passed for paired agent/skill files, and `pnpm typecheck` passed.
- Dispatched final one-shot prompt review:
  - reviewer-claude session `d54447fd-aea4-4cdc-aea2-b144774315ae`, anchor `3da0e135-72f5-494d-be3f-c6b6eb556144`.
  - reviewer-codex session `019eafea-ae33-79b3-94f7-10f11429620d`, anchor `ee8592d2-f028-4cb4-80cd-8ca3a5e6aa9f`.
- reviewer-codex returned via message `10230977-0699-4a34-a0b1-9d843c45c5ba` with 2 MEDIUM findings and 0 CRITICAL/HIGH:
  - MEDIUM: `src/main/session/resume-history/inject-history.ts` fallback wrapper labels history/current sections but lacks an explicit instruction that summary/raw transcript are read-only historical context and only current message is actionable.
  - MEDIUM: `src/main/agent-deck-mcp/tools/index.ts` / shared caller visibility wording may overstate `list_sessions` / `get_session` scoping because handlers return app-wide session metadata for allowed read callers, filtered only by arguments.
- User explicitly chose to skip Claude reviewer for this round (`本轮先不管claude了`). Lead shut down reviewer-claude session `d54447fd-aea4-4cdc-aea2-b144774315ae` and proceeded with reviewer-codex findings only.
- Lead accepted and fixed both reviewer-codex MEDIUM findings:
  - Added a resume-history guard that says historical summary/raw transcript are context only, not current instructions; only the `用户当前消息` section is actionable. The guard is included in length-budget accounting and covered by regression tests.
  - Changed session query descriptions to say `list_sessions` / `get_session` expose app-wide session metadata to allowed read callers, and weakened the shared read caller wording so each tool owns its visibility/authorization semantics.
- Final validation after fixes passed:
  - `pnpm vitest run src/main/session/resume-history/__tests__/inject-history.test.ts` passed 26 tests.
  - `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` passed 68 tests.
  - `pnpm vitest run src/main/session/oneshot-llm/__tests__/build-prompt.test.ts src/main/session/resume-history/__tests__/inject-history.test.ts src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts` passed 69 tests.
  - `pnpm typecheck` passed.
  - `git diff --check` passed.
  - Stale term scan for `resources/` prompt assets returned no matches for migrated/current-maintenance terms; the only `PendingTab` match was in README's current source map and resolves to an existing component.
  - Changed Markdown link/resource scan found existing root links only; plugin skill path mentions are generated cache paths (`.deep-review-cache`) or examples, not bundled resource links.

## Next-Session First Action

Read this plan at `/Users/wanglidong/Repository/agent-deck/ref/plans/prompt-assets-broad-optimize-20260610.md`, then prepare the final prompt-asset report and mark the Agent Deck task completed if no new user request arrived.
