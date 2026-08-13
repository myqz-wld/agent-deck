---
invocation_id: remote-full-ui-parity-20260812-01
review_type: deep-review
baseline_commit: 3ec408aff18c85bdbd4ebb839d4e63a9dbf056e4
review_pair:
  - reviewer-claude
  - reviewer-codex
status: converged
---

# Remote Full UI Parity Deep Review Manifest

## Dispatch records

| Batch | Claude session / anchor | Codex session / anchor |
|---|---|---|
| P1 | `73b28370-b242-482c-b4db-0324bc6fb7f2` / `8a2fea1d-4b86-42a1-972d-ecdaf1aba235` | `019ff4ea-d742-7403-a04f-6fe30ed3bd33` / `5405e28b-3850-4c2a-b4e6-4434274986c6` |
| P2 | `1203cc10-bc25-412d-81dc-13f748128131` / `0d1c63c1-49d9-4823-ac4c-cb2669361206` | `019ff4ea-d9ef-7290-a0ae-90a2c5a09981` / `a5a4d5cb-d1bc-4841-9ac4-fc75c19aa9b2` |
| P3 | `6e2939fb-7a43-400a-b68e-ba36fe7dfb4d` / `9f66f2fb-e282-4e77-bf0d-e0a42fd64276` | `019ff4ea-dd0a-74d3-ad22-04868e4b67f5` / `2e289083-bf73-4846-af58-9b70508fd81b` |
| I1 | `b1fed03d-c104-470f-bd0f-4f7484920359` / `c89ec1a7-14c6-49e7-93e3-30b629f9b9a4` | `019ff4ea-dfff-7360-a2f7-a03ace276df7` / `6192d870-35f0-4ac0-bdac-eab5fad9468a` |

## Residual-correction convergence

- P1: reviewer-claude and reviewer-codex converged after the three residual file-history authority
  corrections. Ingestion authority and snapshot bytes are bound to one opened identity; every
  Remote final-diff history row must match the accepted authority; missing targets are revalidated
  through their current nearest canonical parent. No residual finding remains.
- P2: reviewer-claude and reviewer-codex converged; no residual findings.
- P3: reviewer-claude and reviewer-codex converged after the React StrictMode mounted-lifecycle
  correction; no residual severity findings.
- I1: both reviewers completed the corrected-union integration pass. The bounded rebuttal accepted
  the delayed-intent Core-retargeting mechanism as recommendation-changing MEDIUM and accepted the
  legacy-pagination lifecycle-count defect as MEDIUM. Both are corrected with Renderer pre-dispatch
  origin fencing, exact mutation-authority DTOs, Main pre-client admission, and non-authoritative
  legacy lifecycle counts. The same I1 pair completed bounded correction re-review: both findings
  are closed, no new admissible finding remains, and both reviewers recommend convergence.

## Shared review inputs

- Final plan: `ref/plans/recent-3-days/PLAN_36_remote-full-ui-parity.md`
- Consolidated audit: `ref/evidence/remote-full-ui-parity-audit.md`
- Historical implementation worktree: `agent-deck-019ff1bc-4e3-mspjqqkq` (removed after delivery)
- Baseline: `3ec408aff18c85bdbd4ebb839d4e63a9dbf056e4`
- Review target: baseline-to-current working tree, including every tracked and untracked path below.
- Restrictions: read-only review; no source/index/commit/deployment/process changes; no credential,
  provider core configuration, Worker private material, or live process inspection.
- Validation already passed: typecheck; Electron 930 files / 5,948 tests with two files / three
  tests conditionally skipped; production build; Linux headless; deployment and Relay static
  checks; macOS Worker sandbox; bundled runtimes; logger; architecture; diff/file-size gates.
- Post-correction validation: Electron 44 files / 306 tests; direct pinned Node/Web TypeScript;
  architecture and Core/Node boundaries; deployment automation; Relay and Full static checks;
  diff hygiene and changed-production file-size gates. No live process or deployment state changed.
- Residual-correction validation: Electron 186 files / 1,029 tests; direct pinned Node/Web
  TypeScript; architecture and Core/Node boundaries; diff hygiene and changed-production file-size
  gates. Deterministic coverage includes image intermediate-directory swaps, manifest symlinks,
  transport minimum control capacity, failed adapter initialization, retained-snapshot authority,
  same-session model retry, and deleted-file recorded authority. No live process or deployment state
  changed.
- I1 final-correction validation: full Electron-as-Node run passed 943 files / 6,043 tests with
  only three explicitly conditional live/environment tests skipped. Direct pinned Node/Web
  TypeScript, architecture, Core/Node boundaries, deployment automation, diff hygiene, and touched
  file-size gates passed. Focused mutation-authority and legacy-pagination coverage passed 22 files
  / 106 tests before the full run. Final paired re-review independently passed 22 files / 117 tests
  (reviewer-codex) and 26 files / 154 tests (reviewer-claude), with no residual finding.

## Batch P1 — transport-core-security

- Kind: primary
- Boundary: transport, protocol/contracts, Worker/Core authority, sensitive projections, lifecycle,
  deployment/build verification.
- Deep risks: response/control ordering, reconnect state, lifecycle CAS, exact protocol 2.4 gates,
  sensitive file/value exclusion-before-read, asset revision binding, safe permissions/catalog
  projection, boundedness, and boot before Workspace mount.

- `deploy/linux/relay/README.snippet.md`
- `scripts/build-macos-worker-sandbox.mjs`
- `scripts/check-grok-remote-sandbox.mjs`
- `scripts/deployment/worker-supervisor.mjs`
- `scripts/deployment/worker.mjs`
- `src/clients/ssh/client-failure-modes.test.ts`
- `src/clients/ssh/client.test.ts`
- `src/clients/ssh/config.ts`
- `src/clients/ssh/connection-attempt.ts`
- `src/clients/ssh/connection-state.test.ts`
- `src/clients/ssh/connection-state.ts`
- `src/clients/ssh/errors.ts`
- `src/clients/ssh/frame-writer.test.ts`
- `src/clients/ssh/frame-writer.ts`
- `src/clients/ssh/types.ts`
- `src/contracts/capabilities.ts`
- `src/contracts/index.ts`
- `src/contracts/method-surface.test.ts`
- `src/contracts/methods.ts`
- `src/contracts/node-configuration.test.ts`
- `src/contracts/node-configuration.ts`
- `src/contracts/pending-index.test.ts`
- `src/contracts/pending-index.ts`
- `src/contracts/runtime-dtos.ts`
- `src/contracts/session-messages.test.ts`
- `src/contracts/session-messages.ts`
- `src/contracts/session-outgoing.test.ts`
- `src/contracts/session-outgoing.ts`
- `src/contracts/session-permissions.test.ts`
- `src/contracts/session-permissions.ts`
- `src/contracts/session-presentation.test.ts`
- `src/contracts/session-presentation.ts`
- `src/hosts/daemon/connection-backpressure.test.ts`
- `src/hosts/daemon/connection-handshake.ts`
- `src/hosts/daemon/connection.test.ts`
- `src/hosts/daemon/frame-writer.test.ts`
- `src/hosts/daemon/frame-writer.ts`
- `src/hosts/daemon/types.ts`
- `src/hosts/server-core/issue-projection.ts`
- `src/hosts/server-core/issue-runtime.test.ts`
- `src/hosts/server-core/issue-runtime.ts`
- `src/hosts/server-core/node-asset-catalog.ts`
- `src/hosts/server-core/node-asset-runtime.test.ts`
- `src/hosts/server-core/node-asset-runtime.ts`
- `src/hosts/server-core/node-asset-user-scan.test.ts`
- `src/hosts/server-core/node-asset-user-scan.ts`
- `src/hosts/server-core/node-configuration-runtime.test.ts`
- `src/hosts/server-core/node-configuration-runtime.ts`
- `src/hosts/server-core/remote-sensitive-data.test.ts`
- `src/hosts/server-core/remote-sensitive-data.ts`
- `src/hosts/server-core/repository-host.ts`
- `src/hosts/server-core/runtime-base-methods.ts`
- `src/hosts/server-core/runtime-composition.test.ts`
- `src/hosts/server-core/runtime-composition.ts`
- `src/hosts/server-core/runtime-concurrency.ts`
- `src/hosts/server-core/runtime-core-mutations.test.ts`
- `src/hosts/server-core/runtime-core.test.ts`
- `src/hosts/server-core/runtime-core.ts`
- `src/hosts/server-core/runtime-pending.ts`
- `src/hosts/server-core/runtime-provider-retirement.ts`
- `src/hosts/server-core/runtime-session-extras.ts`
- `src/hosts/server-core/session-console-authority.test.ts`
- `src/hosts/server-core/session-create-capabilities.test.ts`
- `src/hosts/server-core/session-create-capabilities.ts`
- `src/hosts/server-core/session-create-catalog.test.ts`
- `src/hosts/server-core/session-create-catalog.ts`
- `src/hosts/server-core/session-detail-runtime.test.ts`
- `src/hosts/server-core/session-detail-runtime.ts`
- `src/hosts/server-core/session-event-projection.test.ts`
- `src/hosts/server-core/session-event-projection.ts`
- `src/hosts/server-core/session-image-asset.test.ts`
- `src/hosts/server-core/session-image-asset.ts`
- `src/hosts/server-core/session-lifecycle-options.test.ts`
- `src/hosts/server-core/session-lifecycle-options.ts`
- `src/hosts/server-core/session-lifecycle.test.ts`
- `src/hosts/server-core/session-lifecycle.ts`
- `src/hosts/server-core/session-metadata-runtime.test.ts`
- `src/hosts/server-core/session-metadata-runtime.ts`
- `src/hosts/server-core/session-presentation-runtime.test.ts`
- `src/hosts/server-core/session-presentation-runtime.ts`
- `src/hosts/server-core/team-runtime.test.ts`
- `src/hosts/server-core/team-runtime.ts`
- `src/main/store/session-repo/__tests__/pin-lifecycle.test.ts`
- `src/main/store/session-repo/index.ts`
- `src/main/store/session-repo/presentation.ts`
- `src/protocol/version.test.ts`
- `src/protocol/version.ts`

## Batch P2 — desktop-authority-state

- Kind: primary
- Boundary: desktop main/preload/shared Remote authority, source admission/fencing, Local bridge
  isolation, list/detail/data state and pagination.
- Deep risks: zero Local fallback/consumption, connected-only admission, profile/Core/generation
  races, single-flight refresh, idempotency claims, pending/history authority, IPC exactness.

- `src/main/ipc/__tests__/issues-resolution-create.test.ts`
- `src/main/ipc/__tests__/issues-resolution-handler.test.ts`
- `src/main/ipc/__tests__/issues-resolution-rollback.test.ts`
- `src/main/ipc/__tests__/issues.test.ts`
- `src/main/ipc/issue-resolution-session.ts`
- `src/main/ipc/issues.ts`
- `src/main/ipc/remote-host.ts`
- `src/main/remote-host/index.ts`
- `src/main/remote-host/input-validation-session-metadata.ts`
- `src/main/remote-host/input-validation-session-presentation.ts`
- `src/main/remote-host/service-lifecycle-races.test.ts`
- `src/main/remote-host/service-node-assets.test.ts`
- `src/main/remote-host/service-node-assets.ts`
- `src/main/remote-host/service-node-configuration.test.ts`
- `src/main/remote-host/service-node-configuration.ts`
- `src/main/remote-host/service-request-authority.ts`
- `src/main/remote-host/service-session-metadata.test.ts`
- `src/main/remote-host/service-session-metadata.ts`
- `src/main/remote-host/service-session-presentation.test.ts`
- `src/main/remote-host/service-session-presentation.ts`
- `src/main/remote-host/service.test.ts`
- `src/main/remote-host/service.ts`
- `src/preload/api/issues.ts`
- `src/preload/api/remote-host.ts`
- `src/renderer/App.archive-failure.test.tsx`
- `src/renderer/App.tsx`
- `src/renderer/AppWorkspace.tsx`
- `src/renderer/hooks/__tests__/use-local-app-bridges.test.tsx`
- `src/renderer/hooks/use-event-bridge.ts`
- `src/renderer/hooks/use-issues-bridge.ts`
- `src/renderer/hooks/use-local-app-bridges.ts`
- `src/renderer/hooks/use-local-session-state.ts`
- `src/renderer/hooks/use-startup-data-preload.ts`
- `src/renderer/lib/derive-team-role.ts`
- `src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx`
- `src/renderer/remote-host/RemoteDialogs.test.tsx`
- `src/renderer/remote-host/RemoteIssuesPanel.test.tsx`
- `src/renderer/remote-host/RemotePendingRequests.test.tsx`
- `src/renderer/remote-host/SessionDetail.source-shell.test.tsx`
- `src/renderer/remote-host/remote-node-dialog-context.ts`
- `src/renderer/remote-host/remote-session-actions.ts`
- `src/renderer/remote-host/session-summary-presentation.test.ts`
- `src/renderer/remote-host/session-summary-presentation.ts`
- `src/renderer/remote-host/source-navigation.test.ts`
- `src/renderer/remote-host/source-navigation.ts`
- `src/renderer/remote-host/source-types.ts`
- `src/renderer/remote-host/use-remote-host-snapshot.test.tsx`
- `src/renderer/remote-host/use-remote-host-snapshot.ts`
- `src/renderer/remote-host/use-remote-pending-hydrator.ts`
- `src/renderer/remote-host/use-remote-presentation-lists.test.tsx`
- `src/renderer/remote-host/use-remote-presentation-lists.ts`
- `src/renderer/remote-host/use-remote-session-source-detail.test.tsx`
- `src/renderer/remote-host/use-remote-session-source-isolation.test.tsx`
- `src/renderer/remote-host/use-remote-session-source-test-fixture.ts`
- `src/renderer/remote-host/use-remote-session-source.test.tsx`
- `src/renderer/remote-host/use-remote-session-source.ts`
- `src/renderer/remote-host/use-remote-session-tab-data.ts`
- `src/renderer/remote-host/use-remote-usage-source.test.tsx`
- `src/renderer/remote-host/use-remote-usage-source.ts`
- `src/shared/ipc-channels.ts`
- `src/shared/remote-host/public-errors.ts`
- `src/shared/remote-host/session-request-types.ts`
- `src/shared/remote-host/types.ts`

## Batch P3 — renderer-parity

- Kind: primary
- Boundary: shared and Remote renderer presentation, page/dialog interaction, accessibility, safe
  content display.
- Deep risks: Local/Remote structure, Active/Dormant trees, Permissions/Cross-session/detail parity,
  offline/error states, capability-disabled choices, stale confirmations/viewers, read-only assets,
  no sensitive raw fallback, focus/scroll/narrow layout.

- `src/renderer/components/AssetsLibraryDialog.test.tsx`
- `src/renderer/components/AssetsLibraryDialog.tsx`
- `src/renderer/components/DataPanel.tsx`
- `src/renderer/components/HistoryPanel.tsx`
- `src/renderer/components/IssueDetail.tsx`
- `src/renderer/components/NewSessionDialog.tsx`
- `src/renderer/components/PendingTab.tsx`
- `src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx`
- `src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx`
- `src/renderer/components/RemoteHost/RemoteProfileForm.tsx`
- `src/renderer/components/RemotePendingBucketSection.tsx`
- `src/renderer/components/RemoteSessionSummaryCard.tsx`
- `src/renderer/components/ResolveInNewSessionDialog.tsx`
- `src/renderer/components/SessionDetail/MessagesPanel.tsx`
- `src/renderer/components/SessionDetail/RemoteEffectivePermissionsView.tsx`
- `src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx`
- `src/renderer/components/SessionDetail/RemotePendingOutgoingQueue.tsx`
- `src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx`
- `src/renderer/components/SessionDetail/RemoteSessionComposer.tsx`
- `src/renderer/components/SessionDetail/RemoteSessionDetail.notice.test.tsx`
- `src/renderer/components/SessionDetail/RemoteSessionDetail.tsx`
- `src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.test.tsx`
- `src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.tsx`
- `src/renderer/components/SessionDetail/composer-sdk/PendingOutgoingQueue.tsx`
- `src/renderer/components/SessionList.tsx`
- `src/renderer/components/SessionModelDisclosure.tsx`
- `src/renderer/components/SessionModelFields.tsx`
- `src/renderer/components/SettingsDialog.remote.test.tsx`
- `src/renderer/components/SettingsDialog.test.tsx`
- `src/renderer/components/SettingsDialog.tsx`
- `src/renderer/components/TeamDetail/__tests__/TeamDetail.test.tsx`
- `src/renderer/components/TeamDetail/index.tsx`
- `src/renderer/components/TeamHub.test.tsx`
- `src/renderer/components/TeamHub.tsx`
- `src/renderer/components/__tests__/DataPanel.test.tsx`
- `src/renderer/components/__tests__/HeaderTokenRates.source.test.tsx`
- `src/renderer/components/__tests__/IssueDetail.forms.test.tsx`
- `src/renderer/components/__tests__/NewSessionDialog.test.tsx`
- `src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx`
- `src/renderer/components/__tests__/SessionList.parity.test.tsx`
- `src/renderer/components/assets/AssetsTab.test.tsx`
- `src/renderer/components/assets/AssetsTab.tsx`
- `src/renderer/components/assets/BoundedTextPreview.test.tsx`
- `src/renderer/components/assets/BoundedTextPreview.tsx`
- `src/renderer/components/assets/BundledAgentRuntimeEditor.tsx`
- `src/renderer/components/assets/ContentViewerModal.tsx`
- `src/renderer/components/assets/RemoteApplicationConventionTab.tsx`
- `src/renderer/components/assets/remote-asset-presentation.ts`
- `src/renderer/components/data-panel/DataPanelView.tsx`
- `src/renderer/components/expandable-content/layer-manager.ts`
- `src/renderer/components/issues/IssueBoard.tsx`
- `src/renderer/components/issues/RemoteIssueResolutionDialog.tsx`
- `src/renderer/components/issues/RemoteIssuesPanel.tsx`
- `src/renderer/components/new-session/NewSessionForm.tsx`
- `src/renderer/components/new-session/RemoteWorkspaceDirectoryDialog.tsx`
- `src/renderer/components/new-session/session-dialog-actions.ts`
- `src/renderer/components/new-session/session-option-catalog.ts`
- `src/renderer/components/pending-rows/RemotePendingFallbackRow.tsx`
- `src/renderer/components/session-list-tree.ts`
- `src/renderer/components/settings/hook-status-presentation.ts`
- `src/renderer/components/settings/sections/HookSection.tsx`
- `src/renderer/components/settings/sections/LogViewerModal.tsx`
- `src/renderer/components/settings/sections/__tests__/HookSection.test.tsx`
- `src/renderer/components/team-data-source.test.tsx`
- `src/renderer/components/team-data-source.ts`
- `src/renderer/components/use-modal-focus.ts`

## Post-review correction scope

The following paths were added to, or first changed during, the accepted finding correction pass.
They are part of the same primary-batch target and must be included in the targeted re-review.

### P1 correction additions

- `deploy/examples/relay-worker.config.example.json`
- `deploy/examples/remote-session-catalog.example.json`
- `deploy/linux/full/README.snippet.md`
- `deploy/linux/full/server-core.config.example.json`
- `deploy/linux/full/static-check.sh`
- `deploy/linux/relay/local-worker.config.example.json`
- `deploy/linux/relay/static-check.sh`
- `resources/bin/agent-deck-worker`
- `scripts/deployment/config.mjs`
- `scripts/deployment/deployment.test.mjs`
- `src/hosts/local-worker/entrypoint.ts`
- `src/hosts/server-core/node-hook-projection-state.ts`
- `src/hosts/server-core/provider-hook-runtime.test.ts`
- `src/hosts/server-core/provider-hook-runtime.ts`
- `src/hosts/server-core/remote-safe-file-read.test.ts`
- `src/hosts/server-core/remote-safe-file-read.ts`
- `src/main/adapters/__tests__/registry-core.test.ts`
- `src/main/adapters/registry-core.ts`
- `src/main/plugin-assets.ts`
- `src/main/store/__tests__/file-change-repo-test-fixture.ts`
- `src/main/store/__tests__/file-change-repo.test.ts`
- `src/main/store/file-change-read-repo.ts`
- `src/clients/ssh/config.test.ts`
- `src/hosts/daemon/connection-limits.ts`
- `src/hosts/server-core/session-file-path-authority.ts`
- `src/main/ipc/__tests__/sessions-file-changes.test.ts`
- `src/main/ipc/sessions.ts`
- `src/main/plugin-assets.test.ts`
- `src/main/session/file-change-path-authority.test.ts`
- `src/main/session/file-change-path-authority.ts`
- `src/main/session/__tests__/file-change-snapshots.test.ts`
- `src/main/session/__tests__/final-file-diff.test.ts`
- `src/main/session/file-change-snapshots.ts`
- `src/main/session/final-file-diff.ts`
- `src/main/session/manager-ingest-pipeline.ts`
- `src/main/store/__tests__/file-change-path-authority-read.test.ts`
- `src/main/store/__tests__/file-change-path-authority.sqlite.test.ts`
- `src/main/store/file-change-read-authority.ts`
- `src/hosts/server-core/session-file-path-authority.test.ts`
- `src/protocol/control-frame-budget.ts`
- `src/shared/file-change-path-authority.ts`
- `src/shared/types/file.ts`

### P2 correction additions

- `src/main/remote-host/resource-invalidation.test.ts`
- `src/main/remote-host/resource-invalidation.ts`
- `src/renderer/AppWorkspace.remote-parity.test.tsx`
- `src/renderer/app-view-catalog.ts`
- `src/renderer/components/AppHeader.tsx`
- `src/renderer/hooks/use-local-session-focus.ts`
- `src/renderer/remote-host/AppHeader.source-mode.test.tsx`
- `src/renderer/remote-host/RemotePageAvailability.test.tsx`
- `src/renderer/remote-host/RemotePageAvailability.tsx`
- `src/renderer/remote-host/remote-source-utils.ts`
- `src/renderer/remote-host/use-remote-refresh-lane.ts`
- `src/renderer/remote-host/use-remote-source-context.ts`
- `src/renderer/source-authority.ts`

### P3 correction additions

- `src/renderer/components/HandOffPreviewDialog.tsx`
- `src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx`
- `src/renderer/components/__tests__/HandOffPreviewDialog.a11y.test.tsx`
- `src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx`
- `src/renderer/components/__tests__/IssuesPanel.membership.test.tsx`
- `src/renderer/components/__tests__/SessionModelFields.test.tsx`
- `src/renderer/components/issues/IssueBoard.test.tsx`
- `src/renderer/components/use-modal-focus.test.tsx`

### I1 final correction scope

- `src/shared/remote-host/session-request-types.ts`
- `src/shared/remote-host/types.ts`
- `src/main/remote-host/input-validation-error.ts`
- `src/main/remote-host/input-validation-mutation-authority.ts`
- `src/main/remote-host/input-validation-profile.ts`
- `src/main/remote-host/input-validation.ts`
- `src/main/remote-host/input-validation.test.ts`
- `src/main/remote-host/input-validation-issues.ts`
- `src/main/remote-host/input-validation-issues.test.ts`
- `src/main/remote-host/input-validation-node-configuration.ts`
- `src/main/remote-host/input-validation-node-configuration.test.ts`
- `src/main/remote-host/input-validation-plan-review.ts`
- `src/main/remote-host/input-validation-plan-review.test.ts`
- `src/main/remote-host/input-validation-session-handoff.ts`
- `src/main/remote-host/input-validation-session-handoff.test.ts`
- `src/main/remote-host/input-validation-session-metadata.ts`
- `src/main/remote-host/input-validation-teams-usage.ts`
- `src/main/remote-host/input-validation-teams-usage.test.ts`
- `src/main/remote-host/pending-response.test.ts`
- `src/main/remote-host/service-detail-reader.ts`
- `src/main/remote-host/service-scope.ts`
- `src/main/remote-host/service-request-authority.ts`
- `src/main/remote-host/service-request-authority.test.ts`
- `src/main/remote-host/service.ts`
- `src/main/remote-host/service.test.ts`
- `src/main/remote-host/service-issues.ts`
- `src/main/remote-host/service-issues.test.ts`
- `src/main/remote-host/service-lifecycle-races.test.ts`
- `src/main/remote-host/service-node-configuration.ts`
- `src/main/remote-host/service-node-configuration.test.ts`
- `src/main/remote-host/service-plan-review.ts`
- `src/main/remote-host/service-plan-review.test.ts`
- `src/main/remote-host/service-session-handoff.ts`
- `src/main/remote-host/service-session-handoff.test.ts`
- `src/main/remote-host/service-session-metadata.ts`
- `src/main/remote-host/service-session-metadata.test.ts`
- `src/main/remote-host/service-session-mutations.ts`
- `src/main/remote-host/service-session-state.ts`
- `src/main/remote-host/service-teams-usage.ts`
- `src/main/remote-host/service-teams-usage.test.ts`
- `src/renderer/components/SettingsDialog.tsx`
- `src/renderer/components/SettingsDialog.remote.test.tsx`
- `src/renderer/components/issues/RemoteIssuesPanel.tsx`
- `src/renderer/components/team-data-source.ts`
- `src/renderer/remote-host/remote-node-dialog-context.ts`
- `src/renderer/remote-host/remote-plan-review-transports.ts`
- `src/renderer/remote-host/remote-plan-review-transports.test.ts`
- `src/renderer/remote-host/remote-session-actions.ts`
- `src/renderer/remote-host/remote-session-actions.authority.test.ts`
- `src/renderer/remote-host/remote-source-utils.ts`
- `src/renderer/remote-host/use-remote-presentation-lists.ts`
- `src/renderer/remote-host/use-remote-session-source.ts`
- `src/renderer/remote-host/use-remote-session-source-detail.test.tsx`

## Batch I1 — integration

- Kind: integration
- Dependencies: P1, P2, P3
- Scope: the complete union above, with emphasis on changed interfaces and end-to-end flows rather
  than repeating file-local style review.
- Deep risks: protocol 2.4 negotiation through Core/Main/preload/renderer; transport outage to
  fail-closed page behavior; lifecycle to list totals/tree; permissions/assets security from
  source-of-truth to DOM; zero Local fallback; all-page authority; packaging/deployment scripts.

## Completion rule

Both confirmed reviewers must complete every primary batch and the final integration batch.
CRITICAL/HIGH and recommendation-changing MEDIUM evidence follows the skill rebuttal/fix/re-review
lifecycle. LOW/INFO is recorded or opportunistically fixed without ceremonial passes.
