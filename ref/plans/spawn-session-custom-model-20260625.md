---
plan_id: spawn-session-custom-model-20260625
created_at: 2026-06-25
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 915e8a6ad875d16c3c1115270282ee578b02f25a
base_branch: main
related_changelog: CHANGELOG_327
---

# spawn_session Custom Model Names

## Goal And Invariants

Let `spawn_session.model` accept provider-specific model ids as a string so new models do not require Agent Deck schema updates. Keep the current alias list as guidance and compatibility, not as a hard validation boundary. Keep `thinking` adapter-scoped because it maps into Agent Deck-owned structured fields.

## Confirmed Scope

- Change the MCP `spawn_session` schema and model-resolution handler.
- Preserve aliases: `haiku`, `sonnet`, `opus`, `fable`, `gpt-5.5`, `gpt-5.4`, `v4-flash`, `v4-pro`.
- Keep Deepseek aliases mapping to runtime ids: `v4-flash` -> `deepseek-v4-flash`, `v4-pro` -> `deepseek-v4-pro[1m]`.
- Update tests and minimal user-visible documentation.

## Exclusions

- Do not make arbitrary SDK options passthrough.
- Do not change sandbox, permission, cwd, team, or agentName validation.
- Do not change default model env settings.

## Completed Checklist

- [x] Update schema from enum to string with alias-focused description.
- [x] Change runtime model resolution to pass unknown model names through.
- [x] Update focused tests for custom model passthrough and alias behavior.
- [x] Update README and changelog.
- [x] Run targeted tests and typecheck.

## Decisions

- `model` is an open string. The target SDK / provider validates custom ids.
- Maintained aliases remain documented so the prompt surface can steer model choice and the aliases can be periodically updated.
- Deepseek aliases remain special because `v4-flash` and `v4-pro` are Agent Deck convenience names that map to provider ids.
- `thinking` remains a strict enum because Agent Deck translates it into adapter-specific structured fields.

## Validation

- `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts` passed.
- `pnpm typecheck` passed.

## Next Session

No follow-up work remains for this plan.
