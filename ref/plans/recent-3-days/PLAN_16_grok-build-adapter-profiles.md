---
plan_id: PLAN_16
title: Grok Build first-class adapter and runtime profiles
status: completed
created_at: 2026-07-23
updated_at: 2026-07-23
completed_at: 2026-07-23
base_branch: main
base_commit: 0d4c3927d0c97c240d11b2a60d505bcd2af0e192
related_review: REVIEW_167
---

# PLAN_16_grok-build-adapter-profiles: Integrate Grok without the abandoned runtime architecture

## Goal and invariants

- Start from the latest clean `main` in a new worktree and branch.
- Integrate Grok Build through an official structured protocol, align it with the Claude
  Code/Codex product ecosystem where the provider can support the behavior, and make capability
  differences explicit.
- Add one typed adapter-runtime-profile mechanism for adapter-specific tools, schemas, prompt
  strategy, bundled resources, model/thinking/mode controls, and actionable unsupported behavior.
- Preserve the abandoned Cursor worktree and its uncommitted files. Do not cherry-pick it or copy
  complete files from its provider-runtime architecture.
- Keep Grok credentials, user configuration, and native sessions owned by the Grok CLI. Never
  mutate `~/.grok` or expose per-session MCP tokens through model-controlled input.

## Confirmed design decisions

- Selected ACP v1 over `grok agent --no-leader stdio`. A bounded comparison showed that
  `agent serve` adds port, secret, daemon, and shared-backend ownership without improving the
  required local recovery path; a new stdio child can load the same native session.
- Kept ACP as the first-class protocol and stdio as the single maintained transport. Headless
  `grok -p`, the remote relay, direct xAI model loops, TUI scraping, and private session-file
  parsing remain outside this adapter.
- Used one child per active Agent Deck Grok session, with stable application/native identity
  separation, per-session MCP injection, serialized prompts, bounded stderr, and SIGTERM/SIGKILL
  cleanup.
- Made attachments capability-negotiated rather than globally assumed. Grok Build 0.2.110
  currently reports image input as unsupported.
- Kept every provider's prompt application native. The profile declares the injection contract and
  resource root; Claude, Codex, and Grok bridges implement that contract through their own SDK/ACP
  surface rather than through a lossy universal prompt wrapper.
- Used authenticated server-side session identity to choose HTTP MCP policy. A caller cannot select
  a more capable profile through tool arguments.
- Retained all 19 current Agent Deck MCP tool names for first-class adapters because their
  operations are provider-neutral. Profiles can apply allowlists, and capability-specific schema
  builders already remove unsupported inputs such as Grok native fork.

## Abandoned-worktree reuse boundary

- Reimplemented only useful protocol lessons: ACP lifecycle ordering, child cleanup and bounded
  stderr, permission/event mapping, binary preflight, and deterministic fake-agent tests.
- Copied no whole file, cherry-picked no commit, and imported none of the runtime ledger,
  activation barrier, proof graph, compatibility restore, prototype/descriptor defenses, or Cursor
  hook suppression.
- The result is roughly 4,541 pre-record additions across runtime, tests, assets, UI, and docs,
  materially below the original estimate because it reuses the official SDK and existing Agent
  Deck session/MCP/handoff paths rather than recreating them.

## Completed checklist

- [x] Verify current Grok ACP, plugin, mode, model, lifecycle, and image capability contracts.
- [x] Compare stdio and serve ownership; select `stdio --no-leader`.
- [x] Add typed profiles and migrate Claude/Deepseek/Codex capability/model declarations without
      changing their behavior.
- [x] Add profile-derived MCP allowlists and capability-specific spawn schema generation.
- [x] Implement Grok initialize/new/load/prompt/cancel, permissions, events, queueing, cleanup, and
      restart recovery through the official SDK.
- [x] Integrate creation, handoff, collaboration, settings, assets, runtime controls, composer
      gating, and reviewer selection.
- [x] Add bundled Grok prompt/plugin/agent/skill assets within the approved prompt-edit scope.
- [x] Add migration and persistence for adapter-native session modes.
- [x] Add fake ACP, profile, tool-policy, migration, IPC, renderer, and asset tests.
- [x] Fix the ESM-only ACP SDK Electron startup boundary found by the clean dev smoke.
- [x] Complete prompt-asset validation, full repository validation, and final records.

## Validation and completion

- `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- The full suite passed 336 files and 2,966 tests; one opt-in credentialed live smoke was skipped.
- Grok plugin validation passed.
- A real Grok 0.2.110 no-paid-prompt smoke completed ACP initialize/new/load/cancel, accepted
  default/plan/ask modes, and reported model `grok-4.5`, embedded context support, and image/audio
  input disabled.
- An isolated Electron development instance initialized the Grok adapter and displayed its window.
- New production modules remain at or below 500 lines; one pre-existing 511-line handoff handler is
  documented in the related changelog after receiving a one-line pass-through.

## Final status and residual boundaries

Completed on 2026-07-23. Grok is not included as a periodic-summary provider because doing so would
add an unrelated oneshot architecture. A paid live model prompt was intentionally not sent; fake
ACP tests cover prompt/event/permission behavior and the real smoke covers the installed protocol
and session lifecycle. Image input remains dynamically gated by the installed CLI's ACP capability.

The runtime-profile registry is deliberately small: it centralizes declarative capabilities,
validation, MCP policy, schema differences, and prompt strategy, while provider-specific bridge
logic remains outside the table. Adding a future adapter requires a profile plus its native bridge,
not modifications to every MCP transport.
