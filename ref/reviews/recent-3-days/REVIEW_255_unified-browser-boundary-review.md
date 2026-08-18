---
review_id: 255
reviewed_at: 2026-08-18
baseline_commit: 8a89c27033bdad938155646d34ea2f26ad9a0b84
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final records and bucket indexes are mechanical evidence derived after the reviewed implementation commit."
---

# REVIEW_255_unified-browser-boundary-review: Unified Browser security and lifecycle boundaries

## Scope and method

This lead review inspected the complete implementation diff from
`7834daeabf453a9a5f38e0e0008873d807255382` through
`8a89c27033bdad938155646d34ea2f26ad9a0b84`. It focused on ambient session
identity, lease replay/spoofing, Skills and oneshot gating, provider sandbox projection,
background WebContentsView lifecycle, renderer/main ownership, annotation attachment authority,
Remote path/identity redaction, and removal of conflicting Local Browser surfaces.

The repository expiry report was run before review. Legacy records without a usable baseline remain
`scope_unknown`; this feature review does not claim to re-review unrelated repository files.

```review-scope
README.md
deploy/linux/manager/linux-headless.package.json
deploy/linux/provider-session/Containerfile.grok.in
resources/bin/agent-deck-browser.cjs
resources/bin/agent-deckd
resources/bin/node-repl-browser-bootstrap.cjs
resources/bin/node-repl-browser-process-compat.cjs
resources/claude-config/CLAUDE.md
resources/claude-config/agent-deck-plugin/skills/browser/SKILL.md
resources/codex-config/CODEX_AGENTS.md
resources/codex-config/agent-deck-plugin/skills/browser/SKILL.md
resources/grok-config/GROK_AGENTS.md
resources/grok-config/agent-deck-plugin/skills/browser/SKILL.md
scripts/check-architecture-boundaries.mjs
scripts/check-core-node-boundaries.mjs
scripts/check-linux-headless-support.mjs
scripts/check-linux-headless.mjs
scripts/fixtures/browser-engine-electron.ts
src/contracts/provider-session-container.test.ts
src/contracts/provider-session-container.ts
src/hosts/provider-session/browser-runtime.test.ts
src/hosts/provider-session/browser-runtime.ts
src/hosts/provider-session/multiplex.test.ts
src/hosts/provider-session/multiplex.ts
src/hosts/provider-session/node-mounts.test.ts
src/hosts/provider-session/node-mounts.ts
src/hosts/provider-session/node-oci.test.ts
src/hosts/provider-session/oci-command.test.ts
src/hosts/provider-session/oci-command.ts
src/hosts/provider-session/shim-entrypoint.test.ts
src/hosts/provider-session/shim-entrypoint.ts
src/hosts/provider-session/supervisor.test.ts
src/hosts/provider-session/types.ts
src/hosts/server-core/browser-artifact-store.test.ts
src/hosts/server-core/browser-artifact-store.ts
src/hosts/server-core/browser-cli-executor.test.ts
src/hosts/server-core/browser-cli-executor.ts
src/hosts/server-core/browser-composition.ts
src/hosts/server-core/browser-runtime.test.ts
src/hosts/server-core/browser-runtime.ts
src/hosts/server-core/mcp-server.test-fixture.ts
src/hosts/server-core/mcp-server.test.ts
src/hosts/server-core/provider-browser-runtime.test.ts
src/hosts/server-core/provider-claude-query-host.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-grok-container-production.ts
src/hosts/server-core/provider-grok-container-runtime.test.ts
src/hosts/server-core/provider-grok-container-runtime.ts
src/hosts/server-core/provider-grok-container-transport.test.ts
src/hosts/server-core/provider-grok-container-transport.ts
src/hosts/server-core/provider-grok-host.ts
src/hosts/server-core/provider-host-common.ts
src/hosts/server-core/provider-runtime-lifecycle.test.ts
src/hosts/server-core/provider-runtime-lifecycle.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-provider-container.ts
src/hosts/server-core/runtime-provider-host.ts
src/main/adapters/__tests__/runtime-profiles.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-core.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-host.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query.ts
src/main/adapters/codex-cli/app-server/client-diagnostics.ts
src/main/adapters/codex-cli/app-server/client-host-port.ts
src/main/adapters/codex-cli/app-server/client-process-diagnostics.test.ts
src/main/adapters/codex-cli/app-server/client-process-host.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap-adapter.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap-policy.test.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap.test.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/thread-readiness.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction-host.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction.test.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction.ts
src/main/adapters/grok-build/__tests__/launch-child.test.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/bridge-runtime-core.ts
src/main/adapters/grok-build/bridge-runtime-host.test.ts
src/main/adapters/grok-build/bridge-runtime-host.ts
src/main/adapters/grok-build/launch-child.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/runtime-profiles.ts
src/main/agent-deck-mcp/__tests__/browser-tools.test.ts
src/main/agent-deck-mcp/tools/browser-tools.ts
src/main/agent-deck-mcp/tools/handlers/browser/inspect.ts
src/main/agent-deck-mcp/tools/handlers/browser/interact.ts
src/main/agent-deck-mcp/tools/handlers/browser/shared.ts
src/main/agent-deck-mcp/tools/handlers/browser/tabs.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/browser.ts
src/main/agent-deck-mcp/types.ts
src/main/browser-use/browser-cli-broker-core.ts
src/main/browser-use/browser-cli-broker-protocol.ts
src/main/browser-use/browser-cli-broker.test.ts
src/main/browser-use/browser-cli-broker.ts
src/main/browser-use/browser-cli-frame-relay.ts
src/main/browser-use/browser-cli-resource.test.ts
src/main/browser-use/browser-lease-registry-core.test.ts
src/main/browser-use/browser-lease-registry-core.ts
src/main/browser-use/browser-lease-registry.ts
src/main/browser-use/browser-presentation-controller.test.ts
src/main/browser-use/browser-presentation-controller.ts
src/main/browser-use/browser-presentation-runtime.ts
src/main/browser-use/browser-runtime-context-host.test.ts
src/main/browser-use/browser-runtime-context-host.ts
src/main/browser-use/browser-runtime-context.test.ts
src/main/browser-use/browser-runtime-context.ts
src/main/browser-use/browser-runtime-lifecycle.ts
src/main/browser-use/browser-state-projection.test.ts
src/main/browser-use/browser-state-projection.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/engine/surface.ts
src/main/browser-use/engine/tab.ts
src/main/browser-use/engine/types.ts
src/main/browser-use/operation-contract.test.ts
src/main/browser-use/operation-contract.ts
src/main/browser-use/operation-executor.test.ts
src/main/browser-use/operation-executor.ts
src/main/browser-use/operation-schemas.ts
src/main/browser-use/screenshot-store.ts
src/main/browser-use/session-browser.ts
src/main/browser-use/view-host-core.test.ts
src/main/browser-use/view-host-core.ts
src/main/browser-use/view-host.test.ts
src/main/browser-use/view-host.ts
src/main/browser-use/view-presentation-lifecycle.ts
src/main/codex-config/__tests__/bundled-browser-skill.test.ts
src/main/index/__tests__/_deps.test.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/__tests__/checkpoint-shutdown-entry.test.ts
src/main/index/_deps.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/ipc/__tests__/browser-input.test.ts
src/main/ipc/__tests__/browser.test.ts
src/main/ipc/browser-input.ts
src/main/ipc/browser.ts
src/main/ipc/index.ts
src/main/remote-host/desktop-browser-broker.test.ts
src/main/remote-host/desktop-browser-broker.ts
src/main/remote-host/remote-browser-executor.ts
src/main/session/manager/rename.ts
src/main/window.ts
src/main/window/__tests__/browser-view-presentation-lifecycle.test.ts
src/main/window/__tests__/lifecycle-observability.test.ts
src/main/window/lifecycle.ts
src/main/window/sizing.ts
src/main/window/window-role-registry.test.ts
src/main/window/window-role-registry.ts
src/preload/api/browser.ts
src/preload/index.ts
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/IabAnnotationCanvas.test.ts
src/renderer/components/SessionDetail/IabAnnotationCanvas.tsx
src/renderer/components/SessionDetail/IabPanel.test.tsx
src/renderer/components/SessionDetail/IabPanel.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/SessionDetailShell.tsx
src/renderer/components/SessionDetail/composer-sdk/useAdapterRuntimeInfo.ts
src/renderer/components/SessionDetail/iab-annotation-model.test.ts
src/renderer/components/SessionDetail/iab-annotation-model.ts
src/renderer/components/SessionDetail/iab-composer-bridge.tsx
src/renderer/components/SessionDetail/iab-local-composer-integration.test.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/use-browser-state.ts
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
src/renderer/components/settings/sections/__tests__/AgentDeckMcpSection.test.tsx
src/renderer/hooks/__tests__/useImageAttachments.test.tsx
src/renderer/hooks/image-attachments/types.ts
src/renderer/hooks/useImageAttachments.ts
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
src/shared/browser-view.ts
src/shared/ipc-channels.ts
```

## Findings

No confirmed CRITICAL, HIGH, MEDIUM, LOW, or INFO code finding remains open.

The review found the implementation consistent with the selected boundaries:

- Model-visible CLI arguments cannot choose a session, owner, lease, token, endpoint, cwd, or
  provider identity. The private shim reads a mode-0600 context and the broker validates the
  lease-bound adapter, runtime generation, and source identity before resolving the application
  session.
- Claude, Codex, and Grok Browser runtime contexts follow their existing Skills switches and are
  prepared only on interactive provider construction paths. Oneshot summary/checkpoint runtimes do
  not receive the shim.
- All three Local runtime profiles keep legacy `browser_*` MCP registration false. Desktop Codex
  no longer starts the official Browser native-pipe backend, and its `node_repl` rewrite hook and
  packaged proxies were removed. Server Core's separately owned Remote fallback remains intact.
- Browser presentation stays parked and background-first unless `--show` is explicit. Renderer
  state receives source-qualified tab metadata, not private engine owner ids, and main validates the
  renderer/window/source/presentation lease before presenting or capturing.
- Annotation freezes a bounded PNG, invalidates on viewport/navigation/source/capability changes,
  and can only add `iab-annotation.png` through the existing composer attachment hook. It has no
  direct send or steer authority.
- Close, delete, handoff, restart failure, source disconnect, generation retirement, and app
  shutdown revoke runtime contexts and dispose browser ownership through explicit lifecycle paths.

## Validation and evidence

- Prompt inventory and the seven-record backup manifest verified every original and edited SHA-256;
  the three Browser skills are byte-identical at
  `2e91e93eb69d6f1ea41bdc6ac8baa1738818e33daa7d987669c2251f5a6ce7a8`.
- Prompt/resource validation passed 7 files / 40 tests. Local surface-cutover validation passed 10
  files / 82 tests.
- `pnpm typecheck`, architecture boundaries, `git diff --check`, and logger checks passed.
- `pnpm test:browser-electron` passed all real-Electron multi-view, focus, physical-pixel,
  responsive viewport, and annotation-capture boundaries.
- The complete `pnpm test` suite passed. Only the existing opt-in live Colima Provider acceptance
  and Codex live smoke remained skipped in the ordinary run.
- `pnpm build` passed for main, preload, and renderer. `pnpm verify:linux-headless` passed the
  reproducible Linux roles, amd64/arm64 Feishu runtime builds, static package checks, and deployment
  automation checks.
- The explicit Remote live command stopped before mutation because
  `AGENT_DECK_PROVIDER_LIVE_DOCKER_HOST` was not configured. No external target was guessed or
  created.

## Fixes landed

The review required no post-review code fix. The implementation already landed these risk-reducing
cutovers as separate commits after the replacement path:

- `126b3033`: one complete, byte-identical Browser skill and aligned adapter/README guidance.
- `8a89c270`: disable all Local legacy Browser MCP registration, stop the Codex native pipe,
  remove the `node_repl` bootstrap/proxies, and update the Local MCP settings explanation.

## Residual risk

- Remote CLI/IAB behavior has contract, integration, container, Desktop broker, and full-suite
  coverage, but no live Colima target was configured. The Server Core `browser_*` MCP fallback
  therefore remains enabled and must not be described as retired.
- This review ran inside a session created by the previously installed application, so it cannot
  claim a new-shim Local provider live run. Installed-app restart and wrapper freshness validation
  are the remaining Local acceptance step.
- Real OS taskbar/Dock/Spaces/accessibility and energy behavior beyond the automated Electron
  fixture still depends on the installed macOS acceptance environment.

## Follow-ups

- Remove the Remote MCP fallback only after an explicitly configured live Remote target passes CLI,
  IAB, screenshot, annotation, disconnect/reconnect, and generation-retirement acceptance.
- Re-run a fresh-session Claude/Codex/Grok live matrix after installation when the product workflow
  permits creating those test sessions.

