---
review_id: 241
reviewed_at: 2026-08-13
baseline_commit: f47e66264f4717ccce429109e4c4bd57a0c89a43
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_241_remote-ui-runtime-convergence: Remote UI and runtime convergence

## Scope and method

This review covered the complete baseline-to-working-tree change set for Remote Settings, Assets,
Session Detail, reconnect handling, and the shared Relay/Full background runtime. Three parallel
source audits independently traced Settings field parity, Session Detail/permissions reuse, and the
Remote summary/checkpoint production chain. The corrected union was then validated together with
field-order parity tests, race tests, architecture boundaries, the complete Electron suite, and a
production build.

```review-scope
src/clients/ssh/argv.test.ts
src/clients/ssh/argv.ts
src/contracts/node-configuration.test.ts
src/contracts/node-configuration.ts
src/contracts/session-presentation.test.ts
src/contracts/session-presentation.ts
src/hosts/local-worker/config.test.ts
src/hosts/local-worker/config.ts
src/hosts/local-worker/desktop-state-projection.ts
src/hosts/provider-state/local-worker-desktop-state.ts
src/hosts/server-core/background-checkpoints.ts
src/hosts/server-core/background-composition.ts
src/hosts/server-core/background-summary.ts
src/hosts/server-core/checkpoint-generator-host.ts
src/hosts/server-core/checkpoint-source.ts
src/hosts/server-core/local-worker-desktop-state.test.ts
src/hosts/server-core/mcp-handoff-continuation.ts
src/hosts/server-core/mcp-handoff.test.ts
src/hosts/server-core/mcp-handoff.ts
src/hosts/server-core/mcp-session-spawn.ts
src/hosts/server-core/mcp-spawn-guard.ts
src/hosts/server-core/node-configuration-runtime.test.ts
src/hosts/server-core/node-configuration-runtime.ts
src/hosts/server-core/provider-claude-host.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-mcp-settings.test.ts
src/hosts/server-core/provider-settings.test.ts
src/hosts/server-core/provider-settings.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-mcp-host.ts
src/hosts/server-core/session-lifecycle-options.test.ts
src/hosts/server-core/session-lifecycle-options.ts
src/hosts/server-core/session-lifecycle.ts
src/hosts/server-core/session-manager-observer.ts
src/hosts/server-core/session-presentation-runtime.ts
src/main/adapters/grok-build/run-oneshot-core.test.ts
src/main/adapters/grok-build/run-oneshot-core.ts
src/main/adapters/registry-core.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/__tests__/checkpoint-shutdown-entry.test.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/ipc/__tests__/settings-continuation.test.ts
src/main/ipc/__tests__/teams-handoff-routing.test.ts
src/main/ipc/settings.ts
src/main/ipc/teams.ts
src/main/remote-host/resource-invalidation.test.ts
src/main/remote-host/resource-invalidation.ts
src/main/remote-host/service-node-configuration.test.ts
src/main/session/__tests__/summarizer-revision-cursor.test.ts
src/main/session/continuation-context/__tests__/checkpoint-refresh-service.test.ts
src/main/session/continuation-context/checkpoint-background-refresh.ts
src/main/session/continuation-context/checkpoint-refresh-desktop.ts
src/main/session/continuation-context/checkpoint-refresh-service.ts
src/main/session/continuation-context/resolver-core.ts
src/main/session/continuation-context/resolver.ts
src/main/session/continuation-context/runtime-core.ts
src/main/session/continuation-context/runtime.ts
src/main/session/oneshot-llm/claude-runner-core.ts
src/main/session/oneshot-llm/claude-runner.ts
src/main/session/oneshot-llm/codex-runner-core.ts
src/main/session/oneshot-llm/codex-runner.ts
src/main/session/summarizer/claude-runner-core.ts
src/main/session/summarizer/core.ts
src/main/session/summarizer/desktop.ts
src/main/session/summarizer/index.ts
src/main/session/summarizer/llm-runners.ts
src/renderer/AppWorkspace.remote-parity.test.tsx
src/renderer/AppWorkspace.tsx
src/renderer/components/AppHeader.tsx
src/renderer/components/AssetsLibraryDialog.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionContextUsageChip.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/RemoteEffectivePermissionsView.test.tsx
src/renderer/components/SessionDetail/RemoteEffectivePermissionsView.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.test.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.tsx
src/renderer/components/SessionDetail/SessionComposerView.tsx
src/renderer/components/SessionDetail/SessionDetailShell.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/PendingOutgoingQueue.tsx
src/renderer/components/SessionDetail/composer-sdk/SessionRuntimeControls.tsx
src/renderer/components/SessionDetail/composer-sdk/SessionRuntimeFieldsView.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/SessionMetadataChips.tsx
src/renderer/components/SessionModelDisclosure.tsx
src/renderer/components/SessionModelFields.tsx
src/renderer/components/SessionPinButton.tsx
src/renderer/components/SettingsDialog.remote.test.tsx
src/renderer/components/SettingsDialog.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.a11y.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/PermissionsView.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/__tests__/SessionList.parity.test.tsx
src/renderer/components/__tests__/SessionModelFields.test.tsx
src/renderer/components/activity-feed/records-view.test.tsx
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/assets/ApplicationConventionTab.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.test.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.tsx
src/renderer/components/assets/ProviderCombobox.tsx
src/renderer/components/data-panel/DataPanelView.tsx
src/renderer/components/hand-off/HandOffDialogFrame.tsx
src/renderer/components/hand-off/TargetRuntimeFields.tsx
src/renderer/components/issues/RemoteIssueResolutionDialog.tsx
src/renderer/components/issues/RemoteIssuesPanel.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/RemoteWorkspaceDirectoryDialog.tsx
src/renderer/components/new-session/remote-sandbox-options.ts
src/renderer/components/new-session/session-dialog-actions.ts
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/components/pending-rows/RemotePendingRequests.tsx
src/renderer/components/permissions/B18PermissionViewers.test.tsx
src/renderer/components/permissions/ClaudePermissionsPanels.tsx
src/renderer/components/permissions/CodexPermissionsPanel.tsx
src/renderer/components/permissions/GrokPermissionsPanel.tsx
src/renderer/components/permissions/PermissionsFieldParity.test.tsx
src/renderer/components/permissions/permission-chrome.tsx
src/renderer/components/session-summary-headline.test.ts
src/renderer/components/session-summary-headline.ts
src/renderer/components/settings/AdapterConfigHelp.tsx
src/renderer/components/settings/GrokAgentsMdEditor.tsx
src/renderer/components/settings/ProviderModelThinkingFields.tsx
src/renderer/components/settings/ResetSettingsButton.tsx
src/renderer/components/settings/__tests__/AdapterConfigHelp.test.tsx
src/renderer/components/settings/controls.tsx
src/renderer/components/settings/hook-status-presentation.ts
src/renderer/components/settings/remote-settings-presentation.ts
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/ExperimentalSection.tsx
src/renderer/components/settings/sections/ExternalToolsSection.tsx
src/renderer/components/settings/sections/GrokAuthenticationSection.tsx
src/renderer/components/settings/sections/HookServerSection.tsx
src/renderer/components/settings/sections/LifecycleSection.tsx
src/renderer/components/settings/sections/LogsSection.tsx
src/renderer/components/settings/sections/NotifySection.tsx
src/renderer/components/settings/sections/RemoteNodeConfigurationSection.test.tsx
src/renderer/components/settings/sections/RemoteNodeConfigurationSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/WindowSection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/GrokAuthenticationSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/renderer/remote-host/AppHeader.source-mode.test.tsx
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/RemotePageAvailability.test.tsx
src/renderer/remote-host/RemotePageAvailability.tsx
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
src/renderer/remote-host/remote-node-dialog-context.ts
src/renderer/remote-host/remote-plan-review-transports.ts
src/renderer/remote-host/session-summary-presentation.test.ts
src/renderer/remote-host/session-summary-presentation.ts
src/renderer/remote-host/use-remote-connection-scope.ts
src/renderer/remote-host/use-remote-presentation-lists.ts
src/renderer/remote-host/use-remote-session-source-detail.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/remote-host/use-remote-session-tab-data.ts
src/shared/open-ssh.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Remote Settings duplicated the Local hierarchy but omitted many lifecycle, continuation, summary, Hook, external-tool, experiment, and MCP fields. Existing tests compared only section titles. | Remove the simplified Remote section, feed the Local sections a read-only remote presentation, preserve field order/help text/placeholders, and add ordered field-level parity assertions. |
| HIGH | Relay and Full exposed summary/checkpoint read APIs but did not run producers, so new Remote sessions could remain permanently empty and handoff fell back to raw history. | Add host-neutral summary and checkpoint services to the common Server Core lifecycle, wire configured thresholds and retention, publish summary invalidation, and use the same composition in Relay and Full. |
| HIGH | Session permissions used a separate Remote page with different fields and unsafe assumptions about merged Claude arrays. | Route Local and Remote through the same permission panels, normalize malformed/missing values, retain unavailable slots, and keep sensitive paths/raw configuration out of the Remote projection. |
| MEDIUM | Remote asset and detail requests could survive a reconnect and delay or overwrite the current connection's view. | Fence loads by connection generation, allow fresh requests immediately after reconnect, and reject late results from the previous connection. |
| MEDIUM | Built-in Agent defaults could change the effective provider after the capability revision was described, causing valid Remote Agent launches to fail as stale. | Resolve the Agent first and describe/validate the same effective provider selector used for creation. |
| MEDIUM | Session cards, composer/runtime controls, handoff dialogs, pending rows, and loading states were assembled separately and drifted from Local. | Extract shared presentation pieces and stable field schemas; Remote controllers now supply data and authority without redefining visible layout. |
| MEDIUM | Async summary shutdown was not awaited before provider/database teardown. | Make shutdown drain pending work and await it in both desktop and Server Core lifecycle ordering. |
| LOW | Long model/provider values were clipped in narrow asset cards, and several labels exposed internal implementation vocabulary. | Allow metadata to wrap and replace visible technical wording with user-facing descriptions. |
| LOW | A changed pending request with the same id/revision could retain an earlier answer/error row. | Key fallback presentation state by its content digest so changed requests reset correctly. |

No confirmed finding remains open in scope.

## Validation and evidence

- pnpm typecheck passed, including architecture and Core/Node boundary checks.
- The complete Electron suite passed: 6,176 tests, 0 failures, with 3 explicit
  environment-dependent cases skipped.
- Focused Relay/Full continuation and Server Core validation passed 239 tests with one live smoke
  case skipped; summary-engine validation passed 28 tests; permissions parity validation passed
  35 tests.
- pnpm build completed for main, preload, renderer, and generated build metadata.
- git diff --check passed.
- A browser-loaded production renderer emitted no console warnings/errors and displayed the
  expected desktop-bridge fallback. The already-running production Electron instance owns the
  single-instance lock, so a second live desktop instance could not be opened without interrupting
  the active session. Real Settings/Session Detail visual parity is therefore covered by shared
  component structure and ordered multi-state DOM tests, not claimed from a synthetic screenshot.

## Residual risk

- Provider CLIs and SSH links remain external dependencies. A production deployment verification
  is still required after the reviewed commit is pushed.
- The two touched test files already above 500 lines remain at essentially their baseline size
  (653 -> 656 and 716 -> 716). No production file exceeds 500 lines.

## Verdict

PASS. Remote presentation now converges on shared Local components, and Relay/Full both run the
background services required by the data the UI presents.

