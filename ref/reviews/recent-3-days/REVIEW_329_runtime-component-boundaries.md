---
review_id: 329
reviewed_at: 2026-10-15
baseline_commit: c700f88b25f28106197e5c483a035405a46d4e14
expired: false
---

# Runtime component boundaries and retention audit

## Scope and method

Sequential lead implementation audit of changed source and related provider/host contracts for
PLAN_95. No parallel agents or paired review were requested. The review-expiry helper stopped while
mapping historical coverage; no prior record exempts this change. Evidence consists of local native
source, installed declarations/offline Codex JSON schema, captured pre-change MCP wire catalogs,
deterministic failure/race fixtures, the full repository suite, and private Browser geometry.
This is source validation, not a live model or installed-runtime acceptance test.

```review-scope
src/contracts/grant-policy.test.ts
src/contracts/grant-policy.ts
src/contracts/index.ts
src/contracts/methods.ts
src/contracts/session-component-refresh.ts
src/gateways/feishu/core-verification.test.ts
src/hosts/server-core/node-asset-catalog.ts
src/hosts/server-core/provider-claude-query-host.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-grok-host.ts
src/hosts/server-core/provider-host-common.ts
src/hosts/server-core/runtime-base-methods.ts
src/hosts/server-core/runtime-component-refresh.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-core.test-fixture.ts
src/hosts/server-core/runtime-core.ts
src/hosts/server-core/runtime-session-extras.ts
src/main/adapters/claude-code/adapter-core.ts
src/main/adapters/claude-code/plugin-mirror-store.test.ts
src/main/adapters/claude-code/plugin-mirror-store.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-core.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-host.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor-core.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
src/main/adapters/claude-code/sdk-injection.test.ts
src/main/adapters/claude-code/sdk-injection.ts
src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts
src/main/adapters/codex-cli/adapter-core.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/component-consumers.test.ts
src/main/adapters/codex-cli/app-server/component-consumers.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction.ts
src/main/adapters/codex-cli/sdk-bridge/current-turn-id.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host-core.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host.ts
src/main/adapters/codex-cli/sdk-bridge/session-command-controller.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/component-refresh/claude.ts
src/main/adapters/component-refresh/codex.ts
src/main/adapters/component-refresh/gate.test.ts
src/main/adapters/component-refresh/gate.ts
src/main/adapters/component-refresh/grok.ts
src/main/adapters/component-refresh/native-refresh.test.ts
src/main/adapters/component-refresh/provider-gates.ts
src/main/adapters/component-refresh/requests.ts
src/main/adapters/component-refresh/runtime-mutation.ts
src/main/adapters/grok-build/__tests__/resource-store.test.ts
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/grok-build/__tests__/session-setup.test.ts
src/main/adapters/grok-build/adapter-core.ts
src/main/adapters/grok-build/adapter-host-core.ts
src/main/adapters/grok-build/adapter-host.test.ts
src/main/adapters/grok-build/adapter-host.ts
src/main/adapters/grok-build/aggregate-host-core.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/resource-store.ts
src/main/adapters/grok-build/resources.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/session-setup.ts
src/main/adapters/grok-build/turn-boundary.ts
src/main/adapters/grok-build/turn-queue-helpers.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/types/agent-adapter.ts
src/main/agent-deck-mcp/__tests__/__snapshots__/registry-contract.test.ts.snap
src/main/agent-deck-mcp/__tests__/registry-contract.test.ts
src/main/agent-deck-mcp/tool-definition.ts
src/main/agent-deck-mcp/tool-policy.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/codex-config/skills-installer.test.ts
src/main/codex-config/skills-installer.ts
src/main/codex-config/skills-mirror-store.test.ts
src/main/codex-config/skills-mirror-store.ts
src/main/index/bootstrap-infra.ts
src/main/ipc/__tests__/adapters-component-refresh.test.ts
src/main/ipc/adapters-outgoing.ts
src/main/ipc/remote-host.ts
src/main/remote-host/product-method-directory.ts
src/main/remote-host/service-session-mutations.ts
src/main/remote-host/service.ts
src/main/runtime-assets/desktop-startup.ts
src/main/runtime-assets/plugin-view.test.ts
src/main/runtime-assets/plugin-view.ts
src/main/runtime-assets/session-selection.test.ts
src/main/runtime-assets/session-selection.ts
src/main/runtime-assets/snapshot-store.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/rename.ts
src/preload/api/adapters.ts
src/preload/api/remote-host.ts
src/renderer/components/AppHeader.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/remote-host/remote-session-actions.ts
src/renderer/remote-host/source-types.ts
src/shared/application-session-commands.test.ts
src/shared/application-session-commands.ts
src/shared/ipc-channels.ts
src/shared/session-component-refresh.ts
```

## Findings and fixes

| Severity | Finding | Resolution |
| --- | --- | --- |
| HIGH | Deleting/replacing shared mirrors on toggle/update invalidated paths used by live or resumable sessions. | Immutable content versions, persistent selection/history references, session-owned Claude views, and startup-only collection after history deletion. |
| HIGH | UI idle alone cannot authorize refresh while background tasks, approvals, or the next message still consume component state. | Provider-owned reservation before idle checks; native child/background checks; input/steering fences; lifecycle and runtime-setting precedence; no permission-reply fence. |
| MEDIUM | File publication or a native command acknowledgment alone can overstate effective loading or rollback. | Native inventory checks, preserved prior versions, explicit unsupported/cache-deferred/partial failure outcomes; no automatic provider reconstruction. |
| MEDIUM | Initial Grok investigation missed a session-scoped MCP extension. | Source-verified MCP replacement and session inventory confirmation; Skills/plugin broadcast APIs stay outside the current-session boundary. |
| MEDIUM | Inserting a new Core method can shift compact-grant bits, while appending across a nibble boundary changes encoded length. | Append-only method position and backward decoding of shorter grants; a captured revision-1 fixture retains exactly its original permissions. |
| LOW | Pending badges and the left inline count had inconsistent height/baseline alignment. | Explicit control/badge sizing and shared vertical centering; all four rendered variants measured and visually inspected. |

## Evidence

The local Grok source baseline is `f049847ce9426ee3e33b452cd340f2ef6b900edb`
(shell package 1.0.45), while the installed dependency is 1.0.52. Under
`$GROK_SOURCE/crates/codegen/xai-grok-shell/src/`:

- `agent/mvp_agent/acp_agent.rs` dispatches the relevant extensions.
- `extensions/session_admin.rs` replaces only the target's client MCP seed, merges native managed,
  project, and plugin configuration, and awaits `UpdateMcpServers` completion before `{result:{ok:true}}`.
- `extensions/mcp.rs` exposes `sessionMcpResolved` and per-session server readiness/tools.
  The implementation uses `cache:true`, avoiding broader gateway/auth synchronization.
- `extensions/task.rs` supplies session-scoped background-task and running-child inventories.
- Skills reload broadcasts `ReloadSkills` to resident sessions and acknowledges enqueueing. Plugin
  reload rebuilds shared cache state and broadcasts updates. Neither proves isolated current-session
  adoption and neither is called here.

The same MCP source handlers were also checked in the official upstream repository. Source evidence
supports the implementation path; installed runtime support is still checked through bounded calls
when the user explicitly invokes refresh. Unknown/unsupported results cannot become success.

Codex 0.162.1 offline generated schemas confirm `skills/extraRoots/set`, forced `skills/list`, and
thread-scoped `mcpServerStatus/list` inputs. Claude 0.3.299 declarations expose the native MCP/plugin/
Skills methods used. These checks did not create provider sessions or read credentials.

Tool Search remains native. The planning comparison of 52,906 metadata characters for 20 tools and
7,266 for three example tools is a conditional catalog-size comparison only. Actual wire catalogs
are unchanged by this implementation. No measured net prompt/token/cache or latency improvement is
claimed; per-session activation is unknown until reliable provider evidence is available.

## Validation and fixes landed

- Required typecheck, complete test suite (1,181 files / 7,417 tests), and build passed.
- Fixed a full-suite compatibility failure by appending the new grant bit; added captured old-wire
  coverage, then updated the Feishu probe fixture to use the current policy revision constant.
- Corrected adapter fixtures for session-owned asset selection and immutable publication behavior.
- Added regressions for plugin cache holds, interrupted-view reconstruction, per-session isolation,
  unsupported Grok methods, missing session markers, empty Codex roots, partial native failures,
  queued cancellation, background consumers, and runtime settings versus refresh.
- Local/remote composer and host tests confirm no model send/steer call for application commands,
  preserved invalid input, remote-only routing, idempotency, and no handoff successor redirection.
- Browser geometry and screenshot inspection verified the real header component in four states.
- Shared SQLite binding hash was unchanged; no dependency rebuild/install was used.

## Residual risk and activation

- Live installed provider behavior, observed Tool Search activation, input/cache-token counts, and
  first-tool latency were not probed because real model experiments were not authorized. Runtime
  checks report unsupported or failed outcomes explicitly.
- Native mutations are not globally transactional. If native acknowledgment succeeds but inventory
  verification fails, the UI reports failure and retains known settings and prior asset versions.
- Resumable history intentionally retains old versions. Unknown legacy ownership and corrupt owner
  records fail closed; abrupt termination can leave conservative private recovery artifacts. This
  retention trades disk usage for readable historical paths.
- No source file needs an over-500-line exemption. No schema migration, prompt prose change,
  dependency upgrade, application installation, host restart, or deployment occurred.
- Activation remains a separate user-authorized operation on the exact intended host. The isolated
  worktree and lease were retained at source completion; subsequent Git integration and cleanup
  were explicitly authorized by the owner.

## Related records

- [Implementation](../../changelogs/recent-3-days/CHANGELOG_684_runtime-component-injection.md)
- [Approved plan and source correction](../../plans/recent-3-days/PLAN_95_runtime-component-injection.md)
