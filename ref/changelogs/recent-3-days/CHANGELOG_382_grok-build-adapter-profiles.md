---
changelog_id: 382
changed_at: 2026-07-23
---

# CHANGELOG_382_grok-build-adapter-profiles: Add Grok Build as a first-class adapter

## Summary

Agent Deck now integrates Grok Build through its official ACP v1 interface and exposes it across
session creation, recovery, handoff, collaboration, runtime controls, settings, assets, and review
workflows. A typed runtime-profile registry now records adapter-specific capabilities, prompt
injection strategies, model/thinking/mode controls, and MCP tool policies for Claude Code,
Deepseek, Codex, and Grok Build.

## Changes

### Grok Build ACP runtime

- Added `@agentclientprotocol/sdk` 1.2.1 and a bounded `grok agent --no-leader stdio` bridge with
  initialize, new/load, prompt, cancel, permission callbacks, queueing, recovery, and deterministic
  child-process cleanup.
- Kept Agent Deck application session ids separate from Grok native session ids and reused the
  existing per-session MCP bearer-token path. Grok authentication and native session storage remain
  owned by the installed CLI.
- Translated ACP text, reasoning, tool, file, plan, permission, and usage notifications into the
  existing event model. Text chunks are separated by ACP message identity before aggregation.
- Added ACP-native model/reasoning and default/plan/ask mode controls. Unsupported Claude/Codex
  sandbox and native-fork inputs are rejected instead of being approximated.
- Negotiated image support at runtime. The tested Grok Build 0.2.110 reports
  `promptCapabilities.image=false`, so attachments are currently hidden and rejected; a future ACP
  implementation reporting `true` enables the existing image-block path without another feature
  switch.

### Adapter-specific runtime profiles

- Added a typed profile per adapter for capabilities, prompt injection strategy, bundled resource
  root, native-tool ownership, accepted thinking/mode values, and MCP tool policy.
- Built HTTP MCP tools from the adapter resolved through the authenticated persisted caller
  session. Model-supplied adapter fields are not trusted. In-process Claude/Deepseek MCP receives
  the known adapter profile; external/global callers retain the existing restricted policy.
- Added allowlist-based tool filtering and capability-specific schema generation. Grok callers do
  not see the impossible `contextMode: "fork"` input. All 19 current tool names remain available to
  the four first-class adapters because they are provider-neutral; future profiles can hide any
  subset without changing transport code.
- Reused profile thinking and session-mode declarations in backend validation and runtime option
  discovery. Each provider bridge continues to apply prompts through its native mechanism:
  Claude system-prompt append, Codex developer instructions, or Grok ACP agent profile/plugin
  metadata.

### Product and prompt ecosystem

- Added Grok to shared types, adapter registry, IPC/preload, creation/recovery, handoff, MCP spawn,
  team delivery, lifecycle cleanup, model controls, recent defaults, capability-gated composers,
  and settings.
- Added a v45 session migration for adapter-native mode state and preserved it through create,
  recovery, continuation, and handoff.
- Added bundled Grok baseline instructions, plugin metadata, `reviewer-grok`, and hello/simple/deep
  review skills. The exactly-two heterogeneous reviewer rule now accepts Grok as a candidate.
- Added Grok assets and injection controls to the Assets Library and packaged resources without
  bundling the Grok binary or modifying `~/.grok`.
- Kept periodic summaries on the existing providers; this change does not introduce a second Grok
  oneshot runtime.

### Packaging and startup

- Bundled the ESM-only ACP SDK into the Electron main artifact instead of externalizing it as a
  CommonJS `require`, preventing a main-process startup failure.
- Added deterministic fake-ACP coverage, profile/tool-policy coverage, and real no-paid-prompt ACP
  lifecycle smoke validation.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 336 files and 2,966 tests; one opt-in credentialed live smoke remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- `grok plugin validate resources/grok-config/agent-deck-plugin` passed.
- Installed Grok Build 0.2.110 completed initialize, new, load, cancel, and all three mode updates
  without sending a paid model prompt.
- An isolated development instance migrated through v45, initialized all four adapters, mounted
  MCP, opened its window through `ready-to-show`, and shut down cleanly.
- Prompt inventory, pre-edit backup manifests, paired Claude/Codex assets, check-only hashes, and
  Grok plugin resources were validated.

## Do Not Split Protection

- `src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts` is 512 lines. It was
  already 511 lines on the verified base and this change adds only the typed `sessionMode`
  pass-through. Splitting the mature handoff transaction solely for one line would increase
  lifecycle risk; revisit when that handler next receives a material responsibility.
- New Grok and profile production files remain within the guardrail. The largest new bridge and the
  updated spawn handler are each 499 lines; the handoff UI coordinator remains exactly 500.

## Related records

- `PLAN_16_grok-build-adapter-profiles.md`
- `REVIEW_167_grok-build-adapter-boundaries.md`
