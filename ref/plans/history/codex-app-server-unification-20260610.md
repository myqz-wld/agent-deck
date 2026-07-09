---
plan_id: codex-app-server-unification-20260610
created_at: 2026-06-10T03:22:00+08:00
status: completed
base_commit: b89a691
base_branch: main
worktree_path: /Users/wanglidong/Repository/agent-deck
motivation_source: user requested authoritative tok/s and removal of remaining Codex SDK runtime paths
---

# Codex App-Server Unification

## Goal

Make Codex runtime usage accounting use the app-server protocol consistently:
live session tok/s should use authoritative `thread/tokenUsage/updated`
delta timing, remaining production oneshot calls should run through
`codex app-server --stdio`, and obsolete `@openai/codex-sdk` live event
translation/rate code should be removed.

## Invariants

- Live Codex chat, resume, spawn, send, and steer remain on
  `CodexAppServerClient`.
- Header tok/s for Codex live sessions uses authoritative app-server usage
  deltas when present; text output estimation is not used for Codex live tok/s.
- Oneshot summary and handoff preserve existing options: cwd, read-only sandbox,
  approval policy `never`, skip git repo check, model override, reasoning effort,
  and timeout cancellation.
- The app-server client keeps per-session MCP/env behavior for live sessions and
  uses a separate lightweight oneshot pool for summary/handoff.
- Existing Claude usage accounting remains unchanged.
- Unrelated dirty files under `src/main/agent-deck-mcp/*` are out of scope.

## Design Decisions

- **D1 Codex live tok/s:** for each `thread/tokenUsage/updated`, treat
  `tokenUsage.last.outputTokens + reasoningOutputTokens` as the authoritative
  delta and divide by elapsed time since the previous authoritative usage tick.
  This avoids incorrectly spreading a delta across the whole turn duration.
- **D2 No Codex text estimate fallback:** because the user goal is tok/s
  authority and current live path is app-server, remove the old
  SDK `ThreadEvent`/text-estimate fallback from production Codex live-rate code.
- **D3 Oneshot runtime:** replace `@openai/codex-sdk` oneshot pooling with a
  `CodexAppServerClient` oneshot pool. Use `startThread(...).run()` on the
  app-server wrapper so callers keep the existing `runCodexOneshot` contract.
- **D4 Package dependency:** remove `@openai/codex-sdk` after production and
  test imports are gone; depend directly on `@openai/codex` for the packaged
  app-server binary/runtime.
- **D5 Diagrams:** this change touches the SDK bridge architecture. PlantUML
  updates are gated by explicit user confirmation per the repository skill
  contract and are not edited in this implementation pass.

## Checklist

- [x] Confirm current live Codex bridge uses app-server.
- [x] Record plan and scope.
- [x] Add app-server oneshot `run()` support and replace the Codex SDK oneshot
      pool.
- [x] Change Codex live tok/s to authoritative usage delta timing.
- [x] Remove obsolete Codex SDK event translator/live-rate code and update tests.
- [x] Remove `@openai/codex-sdk` dependency if no imports remain.
- [x] Add or update targeted tests.
- [x] Add changelog entry.
- [x] Validate with typecheck and targeted tests.
- [x] Mark task and plan complete.

## Validation

- `pnpm typecheck` ✅
- Targeted tests:
  - Codex app-server client oneshot/run behavior
  - Codex live token-rate app-server usage delta behavior
  - Codex oneshot model passthrough after app-server migration
- `pnpm exec vitest run src/main/adapters/codex-cli/app-server/translate.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts` ✅

## Known Risks

- App-server request parameter names differ from the public SDK names; tests must
  lock the mapping used by `CodexAppServerClient`.
- App-server `tokenUsage.last` is assumed to be a delta. If a future Codex
  version changes it to cumulative values, delta timing would overcount until
  adjusted.
- PlantUML architecture docs may need a follow-up update after user confirmation.

## Completion Notes

- Production Codex paths now use app-server for live sessions and oneshot
  summary/handoff.
- `rg '@openai/codex-sdk|loadCodexSdk|translateCodexEvent|handleCodexEventForLiveRate'`
  returns no matches under `src`, `package.json`, or `pnpm-lock.yaml`.
- PlantUML diagram updates remain a confirmation-gated follow-up per the active
  flow-architecture skill contract.
