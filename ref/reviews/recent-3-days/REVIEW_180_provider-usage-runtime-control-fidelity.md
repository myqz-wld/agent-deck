---
review_id: 180
reviewed_at: 2026-07-27
baseline_commit: abc9f8180a9e1e4b828a06c7ae5fff99a6af47a2
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, changelog, review-record, and index maintenance are mechanical archive work."
---

# REVIEW_180_provider-usage-runtime-control-fidelity: Provider truth and controls

## Scope and method

One persistent `gpt-5.6-sol max` reviewer inspected the complete adapter-fidelity diff against
`origin/main@abc9f8180a9e1e4b828a06c7ae5fff99a6af47a2`. The review covered provider-exact token
usage, nullable metric storage, recovery and correlation ordering, approval and sandbox ownership,
public mutation surfaces, renderer truthfulness, migrations, and lifecycle cleanup. The same
reviewer performed seven read-only rounds; each actionable finding was fixed and returned to that
same session until its strict final verdict was PASS.

```review-scope
resources/bin/agent-deck
resources/codex-config/CODEX_AGENTS.md
src/main/__tests__/cli-session-model-options.test.ts
src/main/adapters/__tests__/runtime-control-contracts.test.ts
src/main/adapters/__tests__/runtime-profiles.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-thinking-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-status-permission-mode-sync.test.ts
src/main/adapters/claude-code/sdk-bridge/authoritative-reasoning-usage.ts
src/main/adapters/claude-code/sdk-bridge/constants.ts
src/main/adapters/claude-code/sdk-bridge/create-session/_deps.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/permission-responder.ts
src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/_deps.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller-types.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/session-lifecycle.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/thinking-token-usage.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
src/main/adapters/codex-cli/app-server/client.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/server-request-host.ts
src/main/adapters/codex-cli/app-server/server-request.test.ts
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/permission-controller.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-finalize.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-retirement.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts
src/main/adapters/codex-cli/sdk-bridge/codex-jsonl-fallback.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-new.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-resume.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.test.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/target-runtime.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/live-token-rate.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/permission-controller.ts
src/main/adapters/codex-cli/sdk-bridge/permission-host.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/restart-controller.ts
src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts
src/main/adapters/codex-cli/sdk-bridge/thread-options-builder.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/grok-build/__tests__/history-usage.test.ts
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/history-usage.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/translation-types.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/usage-correlation.ts
src/main/adapters/grok-build/usage-event.ts
src/main/adapters/grok-build/usage-translate.ts
src/main/adapters/grok-build/usage-watermark.ts
src/main/adapters/runtime-control-contracts.ts
src/main/adapters/runtime-profiles.ts
src/main/adapters/types/adapter-context.ts
src/main/adapters/types/create-session-opts.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.preflight.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/__tests__/spawn-fork-handler.test.ts
src/main/agent-deck-mcp/__tests__/spawn-runtime-controls.test.ts
src/main/agent-deck-mcp/__tests__/target-runtime-schema.test.ts
src/main/agent-deck-mcp/__tests__/tool-policy.test.ts
src/main/agent-deck-mcp/tools/handlers/spawn-runtime-controls.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/schemas.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/agent-deck-mcp/tools/schemas/target-runtime.ts
src/main/cli.ts
src/main/ipc/__tests__/adapters-outgoing.test.ts
src/main/ipc/__tests__/permission-mode-parser.test.ts
src/main/ipc/_helpers.ts
src/main/ipc/adapters-runtime-controls.ts
src/main/ipc/adapters.ts
src/main/ipc/permissions.ts
src/main/ipc/settings.ts
src/main/permissions/__tests__/codex-scanner.test.ts
src/main/permissions/codex-scanner.ts
src/main/plan-review/deep-review-session.ts
src/main/session/hand-off/__tests__/target-resolver.test.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/manager-ingest-pipeline.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/token-usage-repo.test.ts
src/main/store/__tests__/v035-migration.test.ts
src/main/store/__tests__/v048-migration.test.ts
src/main/store/__tests__/v049-v051-migrations.test.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v029_sessions_network_dirs.sql
src/main/store/migrations/v048_codex_output_token_totals.sql
src/main/store/migrations/v049_sessions_codex_approval_policy.sql
src/main/store/migrations/v050_sessions_grok_usage_watermark.sql
src/main/store/migrations/v051_token_usage_presence.sql
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/rename.ts
src/main/store/session-repo/types.ts
src/main/store/token-usage-repo.ts
src/preload/api/adapters.ts
src/preload/api/misc.ts
src/renderer/components/DataPanel.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/SandboxSelects.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/__tests__/DataPanel.test.tsx
src/renderer/components/__tests__/PermissionsView.test.tsx
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/permissions/CodexPermissionsPanel.tsx
src/renderer/components/permissions/GrokPermissionsPanel.tsx
src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx
src/renderer/lib/__tests__/sandbox-options.test.ts
src/renderer/lib/sandbox-options.ts
src/shared/__tests__/permission-mode.test.ts
src/shared/types/permission.ts
src/shared/types/session.ts
src/shared/types/settings/permission-scan.ts
src/shared/types/token-usage.ts
```

## Findings and resolutions

| Area | Finding | Resolution |
|---|---|---|
| Provider usage truth | Claude assistant-frame and approximate reasoning data, Codex reasoning semantics, and Grok optional/total-only fields could be persisted as incomplete, duplicated, or fabricated historical usage. | Persist only authoritative provider results; make metrics nullable and applicability-aware; retain exact provider totals; keep tok/s transient. |
| Recovery and policy | Codex restored usage could replay after app-server resume, and reviewer `approvalPolicy: "never"` could disappear across recovery or fork. Claude provider-owned modes could drift across authoritative status updates. | Use Codex `excludeTurns`, persist explicit approval overrides through every lifecycle path, and preserve provider-reported Claude state while restricting public choices to the five approved modes. |
| Adapter ownership | Public CLI, IPC, MCP, hand-off, and UI surfaces accepted or described controls that the selected provider did not own. | Centralize adapter runtime-control ownership, reject foreign fields, render provider-native permission panels, and preserve Codex writable-root/network semantics. |
| Grok cumulative lifecycle | Recovery baselines, late/history correlation, optional-only updates, progressive corrections, and back-to-back notifications exposed multiple order-dependent double-count or undercount paths. | Persist an atomic cumulative watermark, correlate only unique compatible candidates, isolate historical turns, track per-metric covered frontier scope, and advance each provider correction exactly once. |

The reviewer used AFR-001 through AFR-012, with subcases added as deeper ordering paths were found.
All are closed. This record does not invent a retroactive severity distribution for evolving
subcases; the final strict verdict is PASS with no actionable finding.

## Evidence and validation

- The final reviewer independently re-read the complete diff and returned:
  `PASS — no actionable findings`; AFR-001 through AFR-012 are closed.
- The final round specifically replayed both frontier edge sequences:
  - partial persisted `cachedWrite = NULL`, cumulative `3`, extensions `1 → 2 → 3`, next
    cumulative `4`: the frontier remains `3` and the next delta is `1`;
  - fresh cumulative input `10`, extensions `11 → 12`, next cumulative `15`: the frontier reaches
    `12` and the next delta is `3`.
- `pnpm typecheck` passed.
- The six-file Electron-ABI Grok/storage suite passed 71 tests.
- The full Electron-ABI `pnpm test` suite passed 386 files and 3,245 tests; one credentialed paid
  live smoke test remained explicitly skipped.
- `pnpm build`, `pnpm logger:check`, `bash -n resources/bin/agent-deck`, and `git diff --check`
  passed.
- `bash scripts/file-level-review-expiry.sh` completed.
- Changed production files are at or below 500 lines except the pre-existing Claude SDK message
  dispatcher, reduced from 700 to 688 lines with its accounting extraction already separated.

## Fixes landed

- Historical usage now contains provider-returned facts only; unavailable metrics remain
  unavailable, while tok/s stays a simple transient estimate.
- Claude exposes manual, accept-edits, plan, auto, and bypass; provider-only `dontAsk` is preserved
  read-only for an existing session but cannot be publicly selected or inherited into a fresh one.
- Ordinary Codex approval remains provider/config-owned; invisible reviewers retain explicit
  `never`; read-only, workspace-write, danger-full-access, network, writable roots, and native
  approval requests follow Codex semantics.
- Grok remains ACP-native for permissions and modes, with durable atomic cumulative usage and
  order-independent extension reconciliation.

## Residual risk and boundaries

- No paid provider smoke was run. Deterministic protocol fixtures and installed provider typings
  cover the implementation; a manual smoke remains useful for Claude `auto`, Codex native approval
  rows, and Grok ACP permission interaction.
- The flat MCP transport cannot visually hide every foreign field. Adapter-specific schemas
  document ownership and runtime validation rejects incompatible fields.
- Browser Host behavior is outside this review because the baseline already contains Agent Deck's
  browser implementation.

## Follow-ups

Restart Agent Deck before manually exercising the changed main/preload runtime. No unresolved code
finding remains in the reviewed scope.
