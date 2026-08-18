---
review_id: 252
reviewed_at: 2026-08-17
baseline_commit: 76e2b6471db034367d9d1686659c2545fbb0871f
expired: false
---

# REVIEW_252_current-only-compatibility-sweep: Whole-project current-contract cleanup

## Scope and policy

The user requested a whole-project compatibility sweep because Agent Deck has no external users or
supported historical upgrade contract. Six fresh Agent Deck Codex sessions scanned and edited
disjoint functional areas in parallel. The lead then traced every cross-boundary report, returned
orphaned counterparts to their approved owner, inspected production diffs, scanned the integrated
tree for retired symbols, and ran repository-level validation.

The policy remains the one established by REVIEW_204: support the current producer, current
persisted schema, current pinned provider/runtime, and exact current internal protocol. Preserve
live recovery, security, concurrency, lifecycle, platform/provider variation, and fail-closed
version rejection. A keyword such as fallback, compatible, history, or version was never sufficient
removal evidence.

```review-scope
scripts/check-linux-headless-support.mjs
scripts/deployment/config.mjs
scripts/deployment/config.test.mjs
scripts/deployment/current-contracts.test.mjs
scripts/deployment/deployment.test.mjs
scripts/deployment/remote-install.sh
scripts/deployment/remote-manager.sh
scripts/deployment/server.mjs
src/clients/ssh/client-admission.test.ts
src/clients/ssh/client-failure-modes.test.ts
src/clients/ssh/client-security.test.ts
src/clients/ssh/client.test.ts
src/clients/ssh/wire-identifiers.test.ts
src/composition/session-console-runtime.test.ts
src/composition/session-console-runtime.ts
src/contracts/capabilities.ts
src/contracts/grant-policy.test.ts
src/contracts/grant-policy.ts
src/contracts/methods.test.ts
src/contracts/methods.ts
src/contracts/node-assets.ts
src/contracts/runtime-dtos.ts
src/contracts/session-console.ts
src/core/session-console.test.ts
src/core/session-console.ts
src/gateways/im/__tests__/fixture.ts
src/gateways/im/audit-bounds-binding-runtime.test.ts
src/gateways/im/core-output.ts
src/gateways/im/gateway.test.ts
src/hosts/daemon/connection-identifiers.test.ts
src/hosts/daemon/connection.test.ts
src/hosts/electron/__tests__/registry-fixture.ts
src/hosts/electron/model.ts
src/hosts/electron/registry-resilience.test.ts
src/hosts/electron/registry.test.ts
src/hosts/server-core/mcp-handoff-tools.ts
src/hosts/server-core/mcp-issue-tools.ts
src/hosts/server-core/mcp-presentation-tools.ts
src/hosts/server-core/mcp-result.ts
src/hosts/server-core/mcp-server-test-client.ts
src/hosts/server-core/mcp-server.test.ts
src/hosts/server-core/mcp-session-spawn.test.ts
src/hosts/server-core/mcp-session-spawn.ts
src/hosts/server-core/mcp-session-tools.ts
src/hosts/server-core/mcp-spawn-port.ts
src/hosts/server-core/mcp-spawn-tools.ts
src/hosts/server-core/mcp-task-tools.ts
src/hosts/server-core/mcp-worktree-tools.ts
src/hosts/server-core/node-asset-runtime.ts
src/hosts/server-core/node-configuration-runtime.test.ts
src/hosts/server-core/root.test.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-core.test.ts
src/hosts/server-core/session-console-authority.test.ts
src/hosts/server-core/session-console-authority.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize-core.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-new.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-validation.test.ts
src/main/adapters/grok-build/__tests__/hook-translate.test.ts
src/main/adapters/grok-build/__tests__/provider-completion-recovery.test.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/hook-translate.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/run-oneshot-core.test.ts
src/main/adapters/grok-build/run-oneshot-core.ts
src/main/agent-deck-mcp/__tests__/adopted-teams-context-block.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.cutover.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/__tests__/issue-tools.test.ts
src/main/agent-deck-mcp/__tests__/lead-context-block.test.ts
src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts
src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts
src/main/agent-deck-mcp/__tests__/spawn-session-output-contract.test.ts
src/main/agent-deck-mcp/__tests__/task-crud.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/handlers/adopted-teams-context-block.ts
src/main/agent-deck-mcp/tools/handlers/append-issue-context.ts
src/main/agent-deck-mcp/tools/handlers/browser/shared.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/lead-context-block.ts
src/main/agent-deck-mcp/tools/handlers/list-session-events.ts
src/main/agent-deck-mcp/tools/handlers/report-issue.ts
src/main/agent-deck-mcp/tools/handlers/request-diff-review.ts
src/main/agent-deck-mcp/tools/handlers/request-plan-review.ts
src/main/agent-deck-mcp/tools/handlers/send.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
src/main/agent-deck-mcp/tools/handlers/task-create.ts
src/main/agent-deck-mcp/tools/handlers/task-delete.ts
src/main/agent-deck-mcp/tools/handlers/task-get.ts
src/main/agent-deck-mcp/tools/handlers/task-list.ts
src/main/agent-deck-mcp/tools/handlers/task-update.ts
src/main/agent-deck-mcp/tools/handlers/update-issue-status.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/issues.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/tasks.ts
src/main/codex-config/agents-md-installer.ts
src/main/codex-config/gateway-profiles.ts
src/main/hook-server/hook-relay-config.test.ts
src/main/hook-server/hook-relay-config.ts
src/main/remote-host/profile-controller-credential-refresh.test.ts
src/main/remote-host/profile-controller.ts
src/main/remote-host/profile-document.ts
src/main/remote-host/profile-store.test.ts
src/main/remote-host/profile-store.ts
src/main/remote-host/service-snapshot.ts
src/main/remote-host/service.test.ts
src/main/session/__tests__/event-formatter.test.ts
src/main/session/context-window/__tests__/identity.test.ts
src/main/session/context-window/__tests__/policy.test.ts
src/main/session/context-window/identity.ts
src/main/session/context-window/policy.ts
src/main/session/continuation-context/__tests__/fresh-session-executor.test.ts
src/main/session/continuation-context/__tests__/handoff.test.ts
src/main/session/continuation-context/__tests__/initial-turn.test.ts
src/main/session/continuation-context/__tests__/message-classifier.test.ts
src/main/session/continuation-context/__tests__/preparation-cache.test.ts
src/main/session/continuation-context/__tests__/recovery.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/initial-turn.ts
src/main/session/continuation-context/message-classifier.ts
src/main/session/continuation-context/service.ts
src/main/session/continuation-context/types.ts
src/main/session/hand-off/__tests__/ui-coordinator.test.ts
src/main/session/oneshot-llm/__tests__/fixtures/fake-grok-headless.mjs
src/main/session/oneshot-llm/__tests__/grok-runner.test.ts
src/main/session/oneshot-llm/grok-runner.ts
src/main/session/summarizer/event-formatter.ts
src/protocol/messages.test.ts
src/protocol/messages.ts
src/renderer/App.archive-failure.test.tsx
src/renderer/components/AppHeader.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/RemoteHost/RemoteConnectionCards.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx
src/renderer/components/RemoteHost/RemoteProfileForm.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/helpers.ts
src/renderer/components/SessionList.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/__tests__/SessionList.parity.test.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/format.ts
src/renderer/components/activity-feed/rows/tool-row.test.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/viewers/message-content.ts
src/renderer/components/assets/BundledAgentRuntimeEditor.test.tsx
src/renderer/components/pending-rows/RemotePendingRequests.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/renderer/hooks/__tests__/useSessionCreationOptions.test.tsx
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/remote-host/AppHeader.source-mode.test.tsx
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/RemotePendingRequests.test.tsx
src/renderer/remote-host/remote-dialogs-test-fixture.ts
src/renderer/remote-host/session-detail-source-shell-test-fixture.ts
src/renderer/remote-host/source-types.ts
src/renderer/remote-host/use-remote-host-snapshot.test.tsx
src/renderer/remote-host/use-remote-session-source-test-fixture.ts
src/shared/hand-off-headers.ts
src/shared/remote-host/types.ts
```

Mechanical review/plan record moves and bucket indexes are intentionally excluded from the
implementation scope.

## Dispatch envelopes and runtime evidence

All tracks requested and resolved T2, `codex-cli`, `gpt-5.6-sol`, `xhigh`, fresh context,
`workspace-write`, approval policy `never`, and team `compat-cleanup-20260817`. Agent Deck
returned the approved adapter, exact cwd, team id, session id, and reply anchor for every worker.
The success metadata does not echo model, thinking, fresh-context, sandbox, or approval values, so
those observed fields remain unknown; no substitution or fallback was reported.

| Track | Session / task | Exact write boundary | Runtime outcome and validation |
|---|---|---|---|
| A · Provider adapters | `01a0131b-0dc5-7e51-afb2-b182f1df4425` / `1eeb6c6b-3c00-4233-9762-65ae3ebb8489` | `src/main/adapters/**` | Complete; 18 files; 1,323 adapter tests and typecheck passed |
| B · Session/MCP/Browser | `01a0131b-b108-7683-9476-1113e0aa0daa` / `ac9ece46-3f46-467a-b9eb-a0c70207a561` | approved session, MCP, Browser, hook, config, and permission directories | Complete; 59 files; MCP/continuation focused suites, build, and logger passed |
| C · Persistence/Desktop | `01a0131b-b1ea-7273-9a82-109488876f63` / `dcd51637-5673-4695-957f-28d684e71103` | approved store, remote-host, IPC, preload, shared, and app paths | Complete; 9 files; focused tests and Node/Web TypeScript passed |
| D · Remote Core | `01a0131b-b2ce-7d23-8c52-bb35f282e75c` / `270a074b-34a9-40d0-91c5-7b56ab4ef2fb` | hosts, clients, protocol, contracts, core, composition, gateways | Complete; 49 files; 151 core tests plus MCP parity suites and typecheck passed |
| E · Renderer | `01a0131b-b3ac-7d60-9c01-b89fd58262ea` / `a18b2efe-b4c7-428a-8a7d-0c940eeeaa4e` | `src/renderer/**` | Complete; 37 files; 798 renderer tests, follow-up tests, and Web TypeScript passed |
| F · Tooling/Deployment | `01a0131b-b48d-76c1-8a63-6134d46e2ab4` / `a77636fb-6123-405f-b70b-3937fbea83f6` | scripts, deploy, bundled wrappers/native helpers | Complete; 6 tracked + 2 new tests; deployment/static/syntax checks passed |

Worker scopes never overlapped. The lead recorded a clean pre-dispatch baseline and verified every
changed path after integration. Runtime details and reply anchors are also archived in PLAN_40.

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Remote-host persistence rewrote schema v3 into v4, retained a credential-refresh marker, and exposed migration-only UI/DTO state despite the current-only database policy. | Accept only remote profile schema v4, reject v3 before writes, and delete the migrator, refresh gate, DTO field, producer, UI, fixtures, and dedicated test. |
| MEDIUM | Grok adapter/session readers accepted speculative Claude-style, snake/camel alias, old headless output, and old usage fields without a current Grok 1.0.4 producer. | Keep native current hook/extension forms and `text`/`structuredOutput` plus `input_tokens`/`output_tokens`; delete unsupported aliases in both adapter and session runners. |
| MEDIUM | Agent Deck MCP and Server Core MCP duplicated successful objects as JSON text; several tools lacked strict output schemas. | Return empty content plus `structuredContent` for every non-Browser success and publish strict output schemas on Desktop and Core. Preserve Browser text/image results and explicit text errors. |
| MEDIUM | Remote Core retained seven unused methods, six orphan capabilities, an alias method, and additive field acceptance under the sole current protocol 2.7. | Delete the methods/capabilities/dispatchers and require exact current hello, access, request, result, error, event, cancel, and control envelopes. |
| MEDIUM | Deployment readers and bridges accepted unversioned/incomplete configs, extra artifact layouts, retired manager commands, and prefix-only verification output. | Require exact current Full/Worker schemas, Node 22 manifests, archive/runtime file manifests, produced manager commands, and instance/image-bound verification output. |
| MEDIUM | Continuation v1, an adopted-teams context builder, and zero-caller config/context/hook facades remained after the current handoff cutover. | Keep continuation v2 only, delete the orphan builder/facades/tests, remove adopt headers/parsers/narratives, and retain a neutral strict unknown-key test. |
| LOW | Renderer code feature-detected required preload methods and sole-produced remote fields, normalized impossible absent values, and retained stale activity aliases. | Make current source fields/callbacks required and remove unreachable UI, optional branches, fallback fixtures, and `model_reasoning_effort` event interpretation. |
| LOW | Current-only contract names and comments still carried removed aliases or historical path narratives. | Rename diagnostics to the sole catalog method, delete stale schema fixtures and comments, and preserve only evidence-backed current recovery terminology. |

## Fixes landed

- Deleted three compatibility-only files and added two exact deployment contract tests.
- Changed 180 implementation/test files: 1,581 insertions and 1,793 deletions, net 212 lines removed.
- Collapsed Remote Host, continuation, MCP, Core protocol, renderer, adapter, and deployment inputs to
  their current producers.
- Kept Codex quota variants, current provider event shapes, Browser/node_repl process preload,
  protocol incompatibility reporting, history token reconciliation, session-id rename fencing,
  corruption recovery, deployment idempotence/rollback, and bounded fallbacks with live producers.
- Updated all affected review and plan time buckets and archived PLAN_40.

## Validation and evidence

- `pnpm typecheck`: passed architecture boundaries, core/node boundaries, Node TypeScript, and Web
  TypeScript.
- `pnpm test`: 971 files and 6,134 tests passed; 2 files and 3 explicit live/platform tests skipped.
- `pnpm build`: passed main, preload, renderer, and build-info generation.
- `pnpm check:deployment`: passed.
- `pnpm logger:check`: passed with zero `console.*` residue.
- `bash scripts/file-level-review-expiry.sh`: completed. The six whole-area scans covered the active
  project instead of relying on old exemptions.
- `git diff --check` and the approved path audit: passed.
- Changed non-test source files over 500 lines: none.
- Residual removed-symbol scans found no production reference to remote profile v3 migration,
  `connectionCredentialConfigured`, continuation v1 wrappers, adopted-team headers/builders,
  removed Core methods/capabilities, or old MCP text-success helpers.

## Residual risk

- The active Electron process was not restarted because it owns this delivery session. Main-process
  changes take effect on the next normal Agent Deck launch.
- The Docker-backed Feishu runtime artifact build was not repeated. New manifest/config behavior has
  direct unit coverage, and deployment/static/syntax checks passed.
- Current provider history backfill, session identity migration, protocol incompatibility states,
  and operational rollback/recovery remain intentionally supported. They are runtime behavior, not
  historical format compatibility.
- No changed non-test source exceeds the 500-line guardrail.

## Follow-ups

None required. Reintroduce compatibility only with a concrete current producer, persisted-format
support decision, or explicit external contract.
