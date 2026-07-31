---
review_id: 206
reviewed_at: 2026-07-31
baseline_commit: f5e8bc5bbd02090d8817c5acac98c34c60d462a5
expired: false
---

# REVIEW_206_runtime-selector-hook-security: Runtime selectors and Hook security

## Scope and method

Reviewed the recent Hook, Claude Gateway, Codex provider, and cross-adapter integration changes
against immutable baseline `b268d7b3` and target `f5e8bc5b`. At the user's request, the review used
homogeneous `reviewer-codex` / Codex sub-sessions at `gpt-5.6-sol` with maximum reasoning, followed
by bounded rebuttal and exact-runtime verification. Findings below consolidate duplicate reports by
root cause.

```review-scope
resources/README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/__tests__/bundled-agent-runtime-validation.test.ts
src/main/__tests__/bundled-assets-multi-root.test.ts
src/main/__tests__/cli-session-model-options.test.ts
src/main/adapters/__tests__/runtime-control-contracts.test.ts
src/main/adapters/__tests__/runtime-profiles.test.ts
src/main/adapters/__tests__/session-creation-defaults.test.ts
src/main/adapters/__tests__/session-model-options.test.ts
src/main/adapters/codex-cli/__tests__/codex-instance-pool.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts
src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts
src/main/adapters/codex-cli/app-server/client.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/codex-cli/codex-instance-pool.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/reasoning-effort-resolve.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts
src/main/adapters/codex-cli/sdk-bridge/client-registry.ts
src/main/adapters/codex-cli/sdk-bridge/codex-jsonl-fallback.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-new.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-resume.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/reasoning-effort-resolve.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/target-runtime.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts
src/main/adapters/codex-cli/sdk-bridge/thread-options-builder.ts
src/main/adapters/codex-cli/summarizer-runner.ts
src/main/adapters/options-builder.ts
src/main/adapters/runtime-control-contracts.ts
src/main/adapters/runtime-profiles.ts
src/main/adapters/session-creation-defaults.ts
src/main/adapters/session-model-controller.ts
src/main/adapters/session-model-options.ts
src/main/adapters/types/create-session-opts.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.preflight.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-runtime-overrides.test.ts
src/main/agent-deck-mcp/__tests__/spawn-session-output-contract.test.ts
src/main/agent-deck-mcp/__tests__/target-runtime-schema.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/handlers/get.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/target-request.ts
src/main/agent-deck-mcp/tools/handlers/list.ts
src/main/agent-deck-mcp/tools/handlers/spawn-agent-resolver.ts
src/main/agent-deck-mcp/tools/handlers/spawn-fork-preflight.ts
src/main/agent-deck-mcp/tools/handlers/spawn-runtime-selection.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/agent-deck-mcp/tools/schemas/target-runtime.ts
src/main/bundled-assets.ts
src/main/cli-session-creation.ts
src/main/cli.ts
src/main/codex-config/__tests__/model-providers.test.ts
src/main/codex-config/__tests__/profiles.test.ts
src/main/codex-config/__tests__/toml-writer.test.ts
src/main/codex-config/agent-deck-mcp-injector.ts
src/main/codex-config/model-providers.ts
src/main/codex-config/profiles.ts
src/main/codex-config/toml-writer.ts
src/main/hook-server/curl-command.test.ts
src/main/hook-server/curl-command.ts
src/main/hook-server/hook-config-file.test.ts
src/main/hook-server/hook-config-file.ts
src/main/hook-server/hook-relay-config.test.ts
src/main/hook-server/hook-relay-config.ts
src/main/ipc/__tests__/assets-read-only.test.ts
src/main/ipc/__tests__/permissions-codex-home.test.ts
src/main/ipc/__tests__/settings-continuation.test.ts
src/main/ipc/assets.ts
src/main/ipc/permissions.ts
src/main/ipc/session-hand-off.ts
src/main/ipc/settings-continuation-validation.ts
src/main/permissions/__tests__/codex-scanner.test.ts
src/main/permissions/codex-scanner.ts
src/main/session/continuation-context/codex-isolation.ts
src/main/session/continuation-context/runtime.ts
src/main/session/hand-off/__tests__/target-resolver.test.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/oneshot-llm/codex-runner.ts
src/main/store/session-repo/core-crud.ts
src/main/user-assets.test.ts
src/main/user-assets.ts
src/main/window/__tests__/navigation-policy.test.ts
src/main/window/navigation-policy.ts
src/preload/api/issues.ts
src/preload/api/misc.ts
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/SessionRuntimeControls.tsx
src/renderer/components/SessionModelDisclosure.tsx
src/renderer/components/SessionModelFields.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.test.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.tsx
src/renderer/components/assets/ProviderCombobox.tsx
src/renderer/components/settings/AdapterConfigHelp.tsx
src/renderer/components/settings/ProviderModelThinkingFields.tsx
src/renderer/components/settings/__tests__/AdapterConfigHelp.test.tsx
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/renderer/hooks/useLastSessionDefaults.ts
src/shared/codex-config-profile.ts
src/shared/ipc-channels.ts
src/shared/model-normalize.ts
src/shared/types/assets.ts
src/shared/types/session.ts
src/shared/types/settings/app-settings.ts
```

## Findings and disposition

| Severity | Root cause | Disposition |
|---|---|---|
| HIGH | Every nonempty Codex config profile generated argv rejected by the bundled Codex 0.146.0 app-server. | Fixed by removing process profiles and restoring app-server-supported thread `modelProvider`. |
| HIGH | Durable pre-upgrade Codex `model_provider` strings were reinterpreted as profile filenames across resume, recovery, spawn, fork, handoff, generators, and bundled Agents. | Superseded for historical data by REVIEW_204's explicit current-only v60 cutover. Current-v60 rows/settings retain provider semantics; non-v60 databases remain unsupported rather than migrated. |
| HIGH | curl loaded the default curlrc before the private relay config, allowing another destination to receive the bearer token and hook payload. | Fixed with first-argument `--disable` and a live two-endpoint regression. |
| MEDIUM | Codex config discovery/defaults and permission display disagreed when `CODEX_HOME` was customized. | Fixed by centralizing on the native Codex home and exposing the active provider. |
| MEDIUM | Missing Codex selectors could overwrite summary/checkpoint or bundled-Agent settings before runtime failure. | Fixed with pre-mutation provider resolution and prior-value preservation. |
| MEDIUM | A loaded Codex runtime could retire before a deferred selector startup failure, escaping rollback. | Fixed by rejecting loaded provider changes before any DB/runtime mutation. |
| MEDIUM | Permission UI showed only base config while a different persisted selector was claimed as effective. | Fixed by restoring provider-aware scan metadata and the correct base-config path. |
| MEDIUM | Hook JSON reads followed live links and classified dangling links as absent, allowing replacement or a FIFO main-thread block. | Fixed with lstat-first, no-follow/nonblocking bounded snapshots and CAS identity checks. |
| MEDIUM | Hook status ignores missing, stale, malformed, symlinked, or wrong-mode relay files. | Inspector implemented; adapter-status wiring remains residual pending the separately owned historical-Hook branch. |
| MEDIUM | Historical generated Hooks can remain beside v2 commands in uninspected scopes. | Accepted, documented residual outside the approved write scope; no broad ownership claim was added. |
| LOW | `list_sessions` / `get_session` emitted selector fields without discoverable descriptions or output schemas. | Fixed with strict schemas, descriptions, and matching structured content. |
| LOW | Same-origin comparison admitted an inherited-origin `blob:` target. | Fixed by requiring HTTP(S) on both parsed URLs. |

## Fixes landed

- Restored one Codex provider model across durable storage, adapters, UI, CLI, MCP, generators, and
  Agent metadata; eliminated the unsupported profile grammar and argv.
- Kept Claude Gateway behavior intact and made adapter ownership explicit at public validation
  boundaries.
- Added atomic settings validation, loaded-session provider-change rejection, current-v60
  persistence coverage, custom-`CODEX_HOME` coverage, and real bundled-Codex subprocess evidence.
- Hardened curl and hook-config filesystem boundaries without broadening ownership of historical
  user/project Hooks.
- Completed list/get schema publication and same-origin scheme enforcement.
- Audited and updated paired bundled prompt assets with byte-identical pre-edit backups.

## Validation and evidence

- Focused post-rebase integration scope: 44 files / 498 tests passed.
- Full Electron-ABI suite: 439 files passed, 1 skipped; 3,645 tests passed, 1 skipped.
- Final MCP description/schema recheck: 3 files / 115 tests passed.
- Node and renderer TypeScript checks passed; production build passed.
- `bash scripts/logger-check.sh` and `git diff --check` passed.
- Real Codex 0.146.0 app-server smoke returned `modelProvider: "probe"` from `thread/start`.
- Isolated Electron startup initialized the current v60 schema and bound the combined Hook/MCP
  server on a dynamically allocated loopback port.
- Prompt inventory was refreshed; all eight backup files match the manifest SHA-256 values.

## Residual risk

- Adapter install/status still evaluates only the current v2 command string. The new relay health
  inspector is deliberately not wired until the separately owned historical-Hook migration/removal
  commit becomes reachable; otherwise this branch could reintroduce conflicting ownership logic.
  A deleted or stale relay can therefore still leave Settings showing “installed”.
- Historical Hooks in project-local or otherwise uninspected scopes remain user-owned and may run
  beside v2 Hooks until explicitly removed. This tradeoff was already documented and was excluded
  from the approved implementation scope.
- Codex config-profile selection is intentionally absent. Reconsider only after a pinned stable
  Codex exposes an app-server-native profile loader and the packaged binary passes a subprocess
  contract test.
- Historical selector migration is intentionally absent under REVIEW_204's current-only policy.
  Startup rejects non-v60 databases without mutation; this review does not claim upgrade
  compatibility for those unsupported stores.

## Follow-up

- After the historical-Hook branch lands, wire `inspectHookRelayConfig` into all three adapter
  status paths and add missing/stale/wrong-mode/symlink relay tests without restoring legacy
  recognizers.
