---
plan_id: codex-mid-turn-steering-20260610
created_at: 2026-06-10T00:20:00+08:00
status: completed
base_commit: 2c8cf870dd87b3b1c052046f4908551153232b42
base_branch: main
worktree_path: /Users/wanglidong/Repository/agent-deck-worktrees/codex-mid-turn-steering-20260610
work_branch: codex-mid-turn-steering-20260610
motivation_source: user requested Codex mid-turn steering support and prompt asset updates
---

# Codex Mid-Turn Steering

## Goal

Add mid-turn steering for the Codex adapter by moving the live turn path from
`codex exec --experimental-json` / `@openai/codex-sdk` turn streaming to the
Codex `app-server --stdio` JSON-RPC protocol, then expose the feature through
adapter capabilities, IPC, preload, and the session composer UI.

## User Decisions

- Prompt asset scope is explicitly named by the user:
  - `resources/codex-config/CODEX_AGENTS.md`
  - `resources/claude-config/CLAUDE.md`, including Codex-related runtime
    prompt sections.
- PlantUML maintenance is confirmed by user decision:
  - core change: yes
  - diagram type: both flow and architecture
  - file action: agent decides whether to update existing diagrams or create
    new diagrams.

## Invariants

- Codex steering must only call `turn/steer` when the app has an active
  `threadId` and active `currentTurnId`.
- `expectedTurnId` must be the current active turn id captured from
  `turn/started`; `turn/steer` does not create a new `turn/started`
  notification.
- Steering never accepts per-turn overrides such as cwd, model, or sandbox.
- Review and compact turns are non-steerable; the UI should surface steer only
  through adapter capability and active busy state, while the bridge still
  rejects missing active-turn state.
- Session identity must remain application-side stable. Existing recover /
  fallback behavior must not regress.
- Prompt assets stay self-contained inside Agent Deck bundled resources and
  paired Claude/Codex prompt semantics stay aligned.
- PlantUML files remain `.puml` SSOT only; do not render PNG/SVG outputs.

## Design Decisions

- **D1 Runtime protocol:** introduce a small app-server JSON-RPC client that
  spawns `codex app-server --stdio`, tracks request ids, and dispatches
  notifications. This is required because the current SDK `TurnStartedEvent`
  has no turn id and the SDK `Thread` API has no `steer` method.
- **D2 Translation boundary:** keep app-server notification translation in
  `src/main/adapters/codex-cli/app-server/translate.ts`, parallel to the
  existing `codex-cli/translate.ts`, so protocol-specific event shapes do not
  leak into the bridge.
- **D3 Bridge state:** add `currentTurnId: string | null` to Codex internal
  session state. `turn/started` sets it, and terminal turn notifications clear
  it.
- **D4 UI contract:** add adapter capability `canSteerTurn`. When a session is
  busy and the capability is true, the composer shows a distinct steer input;
  Enter sends a steer request instead of queueing a normal message.
- **D5 Diagram action:** update existing `sdk-bridge-architecture.puml` if it
  can accurately include the app-server boundary, and add or update an SDK
  bridge flow diagram for steering if no existing flow describes mid-turn input.

## Checklist

### Phase 0 - Setup

- [x] Read project entry rules and required skills.
- [x] Confirm PlantUML flow and architecture maintenance with the user.
- [x] Create isolated worktree from local `main`.
- [x] Read current Codex bridge, adapter, IPC, preload, renderer, prompt, and
      diagram files in the worktree.
- [x] Refresh prompt-asset inventory and create local backups for the confirmed
      prompt assets before editing them.

### Phase 1 - App-Server Bridge

- [x] Add app-server JSON-RPC client.
- [x] Add app-server notification to `AgentEvent` translator.
- [x] Update Codex internal session state to track `threadId` and
      `currentTurnId`.
- [x] Switch the Codex live turn loop to `thread/start` / `thread/resume`,
      `turn/start`, notification consumption, and app-server lifecycle cleanup.
- [x] Add `steerTurn(sessionId, text)` to the bridge facade.

### Phase 2 - Product Surface

- [x] Add adapter `steerTurn` type and `canSteerTurn` capability.
- [x] Expose Codex adapter steering through adapter registry facade.
- [x] Add shared IPC channel, main IPC handler, preload API, and renderer type.
- [x] Add SessionDetail steer composer path for busy steerable Codex sessions.

### Phase 3 - Records

- [x] Update prompt assets in the confirmed scope.
- [x] Update or create PlantUML flow and architecture diagrams plus matching
      INDEX rows.
- [x] Add changelog entry and changelog index row.
- [x] Keep this plan progress current.

### Phase 4 - Validation

- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] Targeted tests for Codex app-server translation / steering guards where
      practical.
- [x] Prompt-asset dead-link and paired-asset grep checks.
- [x] PlantUML syntax check if CLI is installed; otherwise verify
      `@startuml` / `@enduml` pairing.

## Current Progress

- User provided protocol findings and confirmed PlantUML maintenance.
- Worktree created at
  `/Users/wanglidong/Repository/agent-deck-worktrees/codex-mid-turn-steering-20260610`.
- Root worktree has one unrelated dirty file outside this plan:
  `src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts`.
  This plan will not touch it.
- Implemented the Codex app-server JSON-RPC client, app-server notification
  translator, bridge `currentTurnId` tracking, `steerTurn`, IPC/preload API, and
  renderer steer composer.
- Updated prompt assets, README user-facing Codex adapter behavior, and both
  architecture / flow PlantUML SSOT diagrams.
- Final validation passed:
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test:node src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts`
  - `plantuml -checkonly ref/architecture/sdk-bridge-architecture.puml ref/flows/codex-mid-turn-steering-flow.puml`
  - `git diff --check`

## Known Risks

- `app-server` protocol shape can drift with Codex CLI upgrades; keep client and
  translator narrow and fail loudly on malformed notifications.
- Replacing the current `@openai/codex-sdk` live turn loop can affect recovery,
  interruption, token-rate, and JSONL fallback paths. Preserve current
  application session identity behavior and add targeted guard tests where the
  bridge state changes.
- `turn/steer` rejects non-active or non-steerable turns. The bridge must reject
  before sending if active state is missing, but protocol-level rejection still
  needs a clear UI error.

## Next-Session First Action

Plan complete. Next action is code review / merge of branch
`codex-mid-turn-steering-20260610`.
