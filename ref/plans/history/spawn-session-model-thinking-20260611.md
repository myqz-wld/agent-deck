---
plan_id: spawn-session-model-thinking-20260611
created_at: 2026-06-11
worktree_path: /Users/wanglidong/Repository/agent-deck
status: in_progress
base_commit: 9cf68a9
---

# spawn_session Model And Thinking Parameters

## Goal

Add explicit `spawn_session` tool parameters for per-session model and thinking complexity, with adapter-scoped validation and runtime passthrough:

- `claude-code`: `haiku`, `sonnet`, `opus`, `fable`
- `codex-cli`: `gpt-5.5`, `gpt-5.4`
- `deepseek-claude-code`: `v4-flash`, `v4-pro`

## Scope

- Add optional tool parameters to the MCP schema so SDK callers can see and use them directly.
- Validate `model` and `thinking` against the selected adapter before `adapter.createSession`.
- Keep bundled agent frontmatter `model` as a fallback when explicit `model` is omitted.
- Pass Codex thinking through `modelReasoningEffort`; map Claude-family thinking only if the adapter supports a real session option.
- Add focused tests for schema/handler validation and option passthrough.

## Exclusions

- Do not redesign model settings UI.
- Do not change default models for normal sessions.
- Do not change existing shutdown-session lifecycle fixes in this worktree.
- Do not update PlantUML diagrams unless the tool-contract diagram gate is explicitly confirmed.

## Checklist

- [x] Inspect existing adapter model/reasoning plumbing.
- [x] Add schema/tool parameter definitions.
- [x] Add adapter-scoped validation and option passthrough.
- [x] Add focused regression tests.
- [x] Run targeted tests and `pnpm typecheck`.

## Risks

- Existing bundled reviewer agents use frontmatter model values; explicit tool args must override without breaking the fallback.
- Codex has a native reasoning field, while Claude-family adapters may encode thinking differently or not support it as a typed option.
- The MCP schema is prompt-facing, so descriptions must stay precise and not advertise invalid adapter/model combinations.

## Follow-up

- Claude-family `thinking: "xhigh"` is accepted and passed through to SDK `options.effort = "xhigh"`.
