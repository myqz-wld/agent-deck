---
review_id: 167
reviewed_at: 2026-07-23
baseline_commit: 0d4c3927d0c97c240d11b2a60d505bcd2af0e192
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Lifecycle-record rebucketing and index maintenance are mechanical archive work."
---

# REVIEW_167_grok-build-adapter-boundaries: Grok ACP and runtime-profile audit

## Scope and method

This review compared the implementation against the approved plan and the user's archived
plan-review feedback. It traced authenticated MCP profile selection, tool/schema filtering, native
prompt injection, Grok child and session lifecycle, recovery, permissions, event aggregation,
attachments, model/mode controls, IPC/UI capability gates, packaging, and prompt assets. Evidence
combined direct diff inspection, deterministic fake ACP tests, the full repository suite, a real
no-paid-prompt Grok lifecycle smoke, and an isolated Electron development startup.

```review-scope
README.md
electron.vite.config.ts
package.json
pnpm-lock.yaml
resources/README.md
resources/claude-config/CLAUDE.md
resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md
resources/claude-config/agent-deck-plugin/skills/simple-review/SKILL.md
resources/codex-config/CODEX_AGENTS.md
resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md
resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md
resources/grok-config/GROK_AGENTS.md
resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md
resources/grok-config/agent-deck-plugin/plugin.json
resources/grok-config/agent-deck-plugin/skills/deep-review/SKILL.md
resources/grok-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md
resources/grok-config/agent-deck-plugin/skills/simple-review/SKILL.md
src/main/__tests__/bundled-assets-multi-root.test.ts
src/main/adapters/__tests__/runtime-profiles.test.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/create-session/_deps.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/deepseek-claude-code/index.ts
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs
src/main/adapters/grok-build/__tests__/permission-controller.test.ts
src/main/adapters/grok-build/__tests__/resolve-grok-binary.test.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/index.ts
src/main/adapters/grok-build/permission-controller.ts
src/main/adapters/grok-build/protocol-utils.ts
src/main/adapters/grok-build/resolve-grok-binary.ts
src/main/adapters/grok-build/resources.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/session-setup.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/options-builder.ts
src/main/adapters/registry.ts
src/main/adapters/runtime-profiles.ts
src/main/adapters/session-model-options.ts
src/main/adapters/types.ts
src/main/adapters/types/agent-adapter.ts
src/main/adapters/types/capabilities.ts
src/main/adapters/types/create-session-opts.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-resolver-grok.test.ts
src/main/agent-deck-mcp/__tests__/spawn-fork-preflight.test.ts
src/main/agent-deck-mcp/__tests__/spawn-prompt.test.ts
src/main/agent-deck-mcp/__tests__/spawn-runtime-controls.test.ts
src/main/agent-deck-mcp/__tests__/tool-policy.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/server.ts
src/main/agent-deck-mcp/tool-policy.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/target-adapter-validation.ts
src/main/agent-deck-mcp/tools/handlers/spawn-agent-resolver.ts
src/main/agent-deck-mcp/tools/handlers/spawn-model-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn-runtime-controls.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/agent-deck-mcp/transport-stdio.ts
src/main/bundled-assets.ts
src/main/cli.ts
src/main/index/bootstrap-infra.ts
src/main/ipc/_helpers.ts
src/main/ipc/adapters.ts
src/main/ipc/assets.ts
src/main/ipc/issues.ts
src/main/ipc/session-hand-off.ts
src/main/ipc/settings.ts
src/main/plan-review/deep-review-session.ts
src/main/session/continuation-context/recovery.ts
src/main/session/continuation-context/resolver.ts
src/main/session/continuation-context/types.ts
src/main/session/hand-off/__tests__/target-resolver.test.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/hand-off/ui-coordinator.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/v045-migration.test.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v045_sessions_adapter_mode.sql
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/rename.ts
src/main/store/session-repo/types.ts
src/preload/api/adapters.ts
src/preload/api/issues.ts
src/preload/api/misc.ts
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/useAdapterRuntimeInfo.ts
src/renderer/components/SessionModelFields.tsx
src/renderer/components/TeamDetail/helpers.ts
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/activity-feed/shared.ts
src/renderer/components/assets/AdapterSubTab.tsx
src/renderer/components/assets/AssetEditor.tsx
src/renderer/components/assets/AssetsTab.tsx
src/renderer/components/assets/InjectionToggleBar.tsx
src/renderer/components/settings/sections/ExternalToolsSection.tsx
src/renderer/hooks/useLastSessionDefaults.ts
src/renderer/lib/adapter-session-modes.ts
src/shared/ipc-channels.ts
src/shared/session-metadata.ts
src/shared/types/assets.ts
src/shared/types/permission.ts
src/shared/types/session.ts
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
src/shared/wire-prefix.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The ACP SDK is ESM-only, while Electron Vite initially externalized it and emitted a CommonJS `require`, causing the real main process to fail before bootstrap despite typecheck, tests, and production build succeeding. | Excluded the ACP SDK from dependency externalization so it is bundled into the Electron main artifact; repeated build and isolated dev startup through `ready-to-show`. |
| MEDIUM | ACP text/thought chunks were initially aggregated only by kind, so consecutive provider messages of the same kind could be merged into one Agent Deck event. | Track ACP `messageId`, flush on identity/kind/tool/plan/terminal boundaries, and add regression coverage. |
| MEDIUM | A child could exit between ACP initialization and the bridge attaching its exit callback, losing the terminal notification and leaving a stale live-runtime entry. | Added a race-safe `onExit` helper that reports both future and already-observed child exits exactly once, then disposes the runtime. |
| MEDIUM | The initial “always allow” mapping selected the first allow decision rather than the ACP `allow_always` option and displayed the persistent action even when the agent had not offered it. | Select exact ACP option kinds, gate the UI action on offered capability, and cover allow-once, allow-always, reject, abort, timeout, and close paths. |

## Validation evidence

- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- `pnpm typecheck` passed.
- `pnpm test` passed 336 files and 2,966 tests; one opt-in credentialed live smoke remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Fake ACP tests exercised initialize, prompt, model, mode, permission, event, usage, and cleanup
  behavior. Profile tests exercised all four adapters, allowlist removal, and Grok's fresh-only
  spawn schema.
- Real Grok 0.2.110 ACP initialize/new/load/cancel and default/plan/ask mode changes succeeded
  without a paid model prompt.
- `grok plugin validate` accepted the bundled plugin.
- Prompt backup manifests and check-only counterpart hashes matched; Claude/Codex paired review
  skills remained aligned.
- An isolated Electron development instance migrated through v45, initialized Grok, mounted MCP,
  showed the renderer window, and shut down cleanly.

## Fixes landed

- Added one bounded ACP stdio runtime instead of importing the abandoned provider-runtime
  foundation.
- Made MCP profile selection depend on authenticated session identity and added adapter-specific
  tool allowlists and schema variants.
- Preserved native prompt paths while centralizing their typed strategy/resource declarations.
- Added dynamic attachment capability negotiation and clear unsupported-action errors.
- Bundled the ESM ACP dependency correctly for Electron main.

## Residual risk and boundaries

- No paid Grok model prompt was sent. Deterministic fake-agent tests cover prompt and event
  semantics; the real smoke covers the installed CLI's protocol, persistence, modes, and cleanup.
- Grok Build 0.2.110 currently reports image and audio input unsupported. Attachment support is
  implemented but remains gated until ACP advertises it.
- Every current first-class adapter receives the same 19 MCP tool names because those tools are
  provider-neutral. Tool allowlisting is active and tested; the first production difference is the
  caller-specific spawn schema because Grok lacks native fork.
- Prompt strategy and roots are declarative profile data, while actual prompt construction remains
  bridge-native. A future adapter still needs a bridge implementation; the profile prevents it from
  requiring changes to every capability, MCP transport, and validation switch.
- One pre-existing handoff handler remains at 512 lines after a one-line mode pass-through; its
  concrete split trigger is recorded in `CHANGELOG_382`.

## Follow-ups

No unresolved material finding remains for this delivery. A Grok periodic-summary runner or
WebSocket daemon should be proposed separately only if a concrete product requirement justifies a
second runtime architecture.
