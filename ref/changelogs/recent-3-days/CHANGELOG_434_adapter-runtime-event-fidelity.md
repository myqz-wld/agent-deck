---
changelog_id: 434
changed_at: 2026-08-05
---

# CHANGELOG_434_adapter-runtime-event-fidelity: Refresh runtimes and restore tool visibility

## Summary

Agent Deck now consumes the current Claude and Codex runtime event shapes without dropping native
Codex collaboration, structured tool results, display items, or timing metadata. The bundled
Claude, Codex, and Grok runtime instructions were also rewritten into a shorter aligned contract,
including an explicit Codex rule that required native child results must be collected before the
lead finishes.

## Dependency refresh

- Advance `@anthropic-ai/claude-agent-sdk` from `^0.3.220` to `^0.3.222` and refresh its lockfile
  graph.
- Keep `@agentclientprotocol/sdk` at `1.3.0`, `@anthropic-ai/sdk` at `^0.115.0`,
  `@openai/codex` at `^0.146.0`, and `@xai-official/grok` at `^0.2.118`; each already matched the
  current stable target checked for this update.
- Verify the bundled Grok runtime and packaged runtime dependency graph after the lockfile change.

## Adapter event fidelity

- Translate Codex 0.146 `collabAgentToolCall` and `subAgentActivity` items into the shared `Agent`
  tool rows, preserving normalized operation names, sender and receiver threads, prompts, model,
  reasoning effort, child states, and failure details. Keep the previously observed
  `collabToolCall` shape as a bounded external-binary fallback.
- Preserve complete raw collaboration arguments and outputs for native v1/v2 and Agent Deck tool
  names, including wait timeouts that normalized items omit.
- Render current Codex web-search results, sleeps, image views, and image-generation summaries;
  avoid persisting inline image base64 while retaining saved paths and result presence.
- Preserve command, MCP, and dynamic-tool durations and the complete MCP result envelope, including
  structured content and metadata. Treat the new collaboration and display item types as trusted
  first-model events for continuation recovery.
- Preserve Claude's single structured `tool_use_result`, accept array content only, and synchronize
  the effective model after a non-local `model_refusal_fallback` event.
- Audit the Grok ACP 1.3 translator against its current tool-call variants and terminal states; no
  source change was required.

## Runtime instruction alignment

- Rewrite the three bundled adapter baselines around the same priority, live-schema, runtime
  ownership, collaboration, browser, plan, worktree, handoff, recovery, and issue boundaries while
  preserving adapter-specific capabilities.
- Distinguish Codex native agents from Agent Deck cross-session workers. Native child completion is
  queued to the parent but does not start a new parent turn, so the lead must continue independent
  work, inspect or wait for required children, consume their results, and close or interrupt any
  child it no longer needs before answering.
- Retain Claude setting-source and one-shot boundaries, Codex Browser-plugin ownership and approval
  defaults, and Grok ACP capability negotiation, session loading, native permission, and browser
  MCP differences.
- Reduce the three resources from 60,811 to 33,696 bytes while retaining the exact
  review, spawn, worktree, and handoff phrases protected by contract tests.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 471 files and 3,877 tests; one opt-in live smoke file/test remained skipped.
- `pnpm build`, `pnpm logger:check`, and `pnpm verify:bundled-runtimes` passed.
- Focused translator, watchdog, and renderer tests cover current and fallback collaboration items,
  Agent row summaries, raw wait parameters, structured MCP and Claude results, timing, web search,
  sleep, images, and model fallback.
- Prompt contract tests, manual self-containment checks, backup hashes, final inventory hashes, and
  `git diff --check` passed.

## Do Not Split Protection

No changed production source exceeds 500 lines. The Claude translator remains 498 lines and the
Codex translator remains 476 lines; display-item translation was extracted into a 77-line module.

## Notes

- No README contains or promises these direct dependency versions, and setup behavior did not
  change, so no README version table required an update.
- Main-process translator changes take effect after a normal rebuild/install and Agent Deck restart.
  The active installed process was not replaced because it owns this delivery session.
- Related review: `REVIEW_215_adapter-event-and-collaboration-compatibility.md`.
