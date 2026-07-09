---
plan_id: "deepseek-summary-handoff-sdk-prompt-20260608"
created_at: "2026-06-08"
worktree_path: "/Users/wanglidong/Repository/agent-deck/.claude/worktrees/deepseek-summary-handoff-sdk-prompt-20260608"
status: "completed"
base_commit: "e5320bfb90251cb5fbbafe952a934b7db115a363"
base_branch: "main"
final_commit: "866cb67116f27a07790bed10539398efac38c698"
completed_at: "2026-06-08T01:27:16Z"
motivation_source: "user requested Deepseek support for periodic summaries and hand-off briefs, latest Codex/Claude SDK upgrades, and prompt asset optimization"
---
# Deepseek Summary/Handoff Provider, SDK Upgrade, Prompt Assets

## Goal

Deliver the three confirmed user outcomes in one isolated plan:

1. Add Deepseek as a first-class provider for periodic summaries and hand-off briefs.
2. Upgrade bundled SDK packages to the latest npm `latest` dist-tags verified on 2026-06-08:
   - `@openai/codex-sdk` `^0.135.0` -> `^0.137.0`
   - `@anthropic-ai/claude-agent-sdk` `^0.3.158` -> `^0.3.168`
3. Optimize the full confirmed prompt-asset baseline:
   - root `README.md`, `CLAUDE.md`, `AGENTS.md`, `resources/README.md`
   - `resources/claude-config/CLAUDE.md` and `resources/codex-config/CODEX_AGENTS.md`
   - bundled reviewer agents and internal skills
   - Agent Deck MCP tool descriptions
   - runtime summary / hand-off prompt code

## User Decisions

- Prompt asset scope: full baseline (`1.A`).
- PlantUML maintenance: update impacted flow / architecture diagrams (`2.A`).
- Deepseek behavior: first-class provider in periodic summary and hand-off settings (`3.A`).

## Invariants

- Deepseek provider reuses the Deepseek Claude Code adapter/provider path instead of introducing a separate SDK family.
- Provider selection remains independent of the target session adapter: a Codex session can be summarized by Deepseek, and a Deepseek session can be summarized by Codex if settings say so.
- Claude and Deepseek model/reasoning behavior stays explicit: Claude-family providers ignore Codex-only reasoning fields; reasoning controls remain enabled only for Codex.
- Prompt assets stay self-contained inside Agent Deck bundled resources; do not make baseline behavior depend on user-installed skills.
- Paired Claude/Codex assets keep protocol semantics aligned while preserving adapter-specific mechanics.
- PlantUML files remain SSOT `.puml` only; do not render PNG/SVG outputs.
- SDK upgrades target npm `latest` dist-tags, not prerelease/alpha dist-tags.

## Design Decisions

- **D1 Provider union expands to `'claude' | 'deepseek' | 'codex'`.** The UI should show Deepseek alongside Claude and Codex for both summary and hand-off rows.
- **D2 Deepseek oneshot runner should use Claude-family SDK plumbing with Deepseek adapter configuration.** Existing `deepseek-claude-code` adapter is the product boundary; new summary/handoff code should route through the adapter registry or shared Claude-family helper rather than copy a third runner.
- **D3 Deepseek model priority mirrors Claude.** Empty model uses provider defaults/env/alias chain; non-empty model is passed to the selected provider. Any provider/model mismatch remains the user's responsibility and should surface as a clear SDK error.
- **D4 UI reasoning select stays disabled for Claude and Deepseek.** Only Codex receives `modelReasoningEffort`.
- **D5 Prompt optimization follows confirmed full baseline scope.** Runtime prompt code is included because user explicitly chose full baseline and the requested Deepseek support touches summary/handoff prompt behavior.
- **D6 Flow/architecture diagrams are updated only when actual implementation changes the documented process.** Existing hand-off and SDK bridge diagrams are likely affected; add or update summary/provider diagrams if no current SSOT covers the new provider selection path.

## Checklist

### Phase 0 - Setup

- [x] Read project entry rules and required skills.
- [x] Confirm prompt asset scope, PlantUML maintenance, and Deepseek product behavior with user.
- [x] Verify latest SDK versions from npm registry.
- [x] Create plan worktree from `base_commit`.
- [x] Read targeted implementation, prompt, and diagram files from the worktree.

### Phase 1 - Deepseek Provider

- [x] Expand shared settings provider types/defaults and UI controls to include `deepseek`.
- [x] Route periodic summary provider selection through Claude / Deepseek / Codex.
- [x] Route hand-off brief provider selection through Claude / Deepseek / Codex.
- [x] Add or adjust tests for provider selection and UI/settings type coverage.

### Phase 2 - SDK Upgrade

- [x] Update `@openai/codex-sdk` to `^0.137.0`.
- [x] Update `@anthropic-ai/claude-agent-sdk` to `^0.3.168`.
- [x] Inspect lockfile/package diff for unexpected transitive or package-name changes.
- [x] Run typecheck after dependency upgrade and adapt code only if required.

### Phase 3 - Prompt Asset Optimization

- [x] Refresh prompt-asset inventory for confirmed full baseline.
- [x] Add `.prompt-asset-improver/local/` to `.gitignore` if missing.
- [x] Create local backups for all prompt assets that may be edited.
- [x] Process local self-improvement queue; current read shows only an already discarded item.
- [x] Run targeted prompt audit: duplicate rules, stale language, vague advice, paired Claude/Codex drift, dead local links, examples, pitfall notes.
- [x] Edit confirmed prompt assets as needed.
- [x] Run prompt-asset dead-link checks and required grep self-checks.

### Phase 4 - PlantUML

- [x] Inspect existing flow/architecture diagrams for summary/provider/handoff coverage.
- [x] Update existing `.puml` files or create missing SSOT diagrams for changed flows.
- [x] Update `ref/flows/INDEX.md` and/or `ref/architecture/INDEX.md`.
- [x] Run `plantuml --check-syntax`; current PlantUML rejects legacy `-syntax` usage.

### Phase 5 - Validation

- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] Targeted tests for summary/handoff/provider selection.
- [x] Review-agent validation for prompt-asset optimization if available; otherwise record self-review coverage gap.

### Phase 6 - Records And Closeout

- [x] Add changelog entry under `ref/changelogs/`.
- [x] Update plan progress and next-session first action.
- [ ] Archive plan through Agent Deck `archive_plan` when worktree is clean and validation is complete.

## Current Progress

- Preflight complete in main repo.
- User confirmed full prompt baseline, PlantUML maintenance, and Deepseek as first-class provider.
- Worktree created at `/Users/wanglidong/Repository/agent-deck/.claude/worktrees/deepseek-summary-handoff-sdk-prompt-20260608`.
- npm registry latest dist-tags verified:
  - `@openai/codex-sdk`: `0.137.0` latest, `0.138.0-alpha.6` alpha.
  - `@anthropic-ai/claude-agent-sdk`: `0.3.168` latest / next.
- Implemented Deepseek summary / hand-off provider routing through `deepseek-claude-code`.
- Upgraded SDK dependencies and lockfile.
- Added `summary-handoff-provider-flow.puml` and `CHANGELOG_230.md`.
- Prompt-asset inventory and backups created under ignored `.prompt-asset-improver/local/`.
- Validation passed: `pnpm typecheck`, `pnpm build`, targeted vitest, PlantUML syntax check, prompt grep checks, `git diff --check`.
- simple-review prompt asset validation completed:
  - reviewer-codex: 0 CRITICAL/HIGH/MEDIUM, 2 LOW + 1 INFO fixed.
  - reviewer-claude: 0 CRITICAL/HIGH/MEDIUM, 1 LOW fixed, 2 INFO either fixed already or out-of-scope.
  - Post-review validation passed: `pnpm typecheck`, targeted vitest, `pnpm build`, final prompt grep, `git diff --check`.
- Link check found two pre-existing dead links in `ref/changelogs/INDEX.md`; recorded follow-up issue `d83db74a-7950-4c3c-937c-e7a3ac242433`.

## Known Risks

- Plan archiving remains open; this session has not merged the worktree back to `main`.
- Prompt backup sequencing had one deviation: `build-prompt.ts` was edited before the first local backup; a supplemental base-state backup from `HEAD` was created to restore pre-edit coverage.
- Diagram maintenance must not create rendered artifacts.

## Next-Session First Action

Read this plan from `/Users/wanglidong/Repository/agent-deck/.claude/plans/deepseek-summary-handoff-sdk-prompt-20260608.md`, then work in `/Users/wanglidong/Repository/agent-deck/.claude/worktrees/deepseek-summary-handoff-sdk-prompt-20260608`. Start by running `git -C /Users/wanglidong/Repository/agent-deck/.claude/worktrees/deepseek-summary-handoff-sdk-prompt-20260608 status --short`, then decide whether to archive/merge the validated worktree.
