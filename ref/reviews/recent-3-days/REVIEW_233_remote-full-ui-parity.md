---
review_id: 233
reviewed_at: 2026-08-12
baseline_commit: 3ec408aff18c85bdbd4ebb839d4e63a9dbf056e4
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical and follows the reviewed result."
---

# REVIEW_233_remote-full-ui-parity: Remote full UI parity and authority

## Scope and method

This severity-driven deep review covered the complete baseline-to-working-tree Remote parity union,
including tracked, untracked, and deleted paths. The work was split into P1 transport/Core/security,
P2 desktop authority/state, P3 renderer parity, and I1 corrected-union integration batches. Each
batch was independently reviewed by the same user-confirmed heterogeneous pair:
`reviewer-claude` and `reviewer-codex`. Every accepted HIGH and recommendation-changing MEDIUM
finding was fixed, rebutted where severity or mechanism differed, and returned to the same pair for
bounded targeted re-review.

The final reviewed scope is the following 311-path product/deployment/test union:

```review-scope
deploy/examples/relay-worker.config.example.json
deploy/examples/remote-session-catalog.example.json
deploy/linux/full/README.snippet.md
deploy/linux/full/server-core.config.example.json
deploy/linux/full/static-check.sh
deploy/linux/relay/README.snippet.md
deploy/linux/relay/local-worker.config.example.json
deploy/linux/relay/static-check.sh
resources/bin/agent-deck-worker
scripts/build-macos-worker-sandbox.mjs
scripts/check-grok-remote-sandbox.mjs
scripts/deployment/config.mjs
scripts/deployment/deployment.test.mjs
scripts/deployment/worker-supervisor.mjs
scripts/deployment/worker.mjs
src/clients/ssh/client-failure-modes.test.ts
src/clients/ssh/client.test.ts
src/clients/ssh/config.test.ts
src/clients/ssh/config.ts
src/clients/ssh/connection-attempt.ts
src/clients/ssh/connection-state.test.ts
src/clients/ssh/connection-state.ts
src/clients/ssh/errors.ts
src/clients/ssh/frame-writer.test.ts
src/clients/ssh/frame-writer.ts
src/clients/ssh/types.ts
src/contracts/capabilities.ts
src/contracts/index.ts
src/contracts/method-surface.test.ts
src/contracts/methods.ts
src/contracts/node-configuration.test.ts
src/contracts/node-configuration.ts
src/contracts/pending-index.test.ts
src/contracts/pending-index.ts
src/contracts/runtime-dtos.ts
src/contracts/session-messages.test.ts
src/contracts/session-messages.ts
src/contracts/session-outgoing.test.ts
src/contracts/session-outgoing.ts
src/contracts/session-permissions.test.ts
src/contracts/session-permissions.ts
src/contracts/session-presentation.test.ts
src/contracts/session-presentation.ts
src/hosts/daemon/connection-backpressure.test.ts
src/hosts/daemon/connection-handshake.ts
src/hosts/daemon/connection-limits.ts
src/hosts/daemon/connection.test.ts
src/hosts/daemon/frame-writer.test.ts
src/hosts/daemon/frame-writer.ts
src/hosts/daemon/types.ts
src/hosts/local-worker/entrypoint.ts
src/hosts/server-core/issue-projection.ts
src/hosts/server-core/issue-runtime.test.ts
src/hosts/server-core/issue-runtime.ts
src/hosts/server-core/node-asset-catalog.ts
src/hosts/server-core/node-asset-runtime.test.ts
src/hosts/server-core/node-asset-runtime.ts
src/hosts/server-core/node-asset-user-scan.test.ts
src/hosts/server-core/node-asset-user-scan.ts
src/hosts/server-core/node-configuration-runtime.test.ts
src/hosts/server-core/node-configuration-runtime.ts
src/hosts/server-core/node-hook-projection-state.ts
src/hosts/server-core/provider-hook-runtime.test.ts
src/hosts/server-core/provider-hook-runtime.ts
src/hosts/server-core/remote-safe-file-read.test.ts
src/hosts/server-core/remote-safe-file-read.ts
src/hosts/server-core/remote-sensitive-data.test.ts
src/hosts/server-core/remote-sensitive-data.ts
src/hosts/server-core/repository-host.ts
src/hosts/server-core/runtime-base-methods.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-concurrency.ts
src/hosts/server-core/runtime-core-mutations.test.ts
src/hosts/server-core/runtime-core.test.ts
src/hosts/server-core/runtime-core.ts
src/hosts/server-core/runtime-pending.ts
src/hosts/server-core/runtime-provider-retirement.ts
src/hosts/server-core/runtime-session-extras.ts
src/hosts/server-core/session-console-authority.test.ts
src/hosts/server-core/session-create-capabilities.test.ts
src/hosts/server-core/session-create-capabilities.ts
src/hosts/server-core/session-create-catalog.test.ts
src/hosts/server-core/session-create-catalog.ts
src/hosts/server-core/session-detail-runtime.test.ts
src/hosts/server-core/session-detail-runtime.ts
src/hosts/server-core/session-event-projection.test.ts
src/hosts/server-core/session-event-projection.ts
src/hosts/server-core/session-file-path-authority.test.ts
src/hosts/server-core/session-file-path-authority.ts
src/hosts/server-core/session-image-asset.test.ts
src/hosts/server-core/session-image-asset.ts
src/hosts/server-core/session-lifecycle-options.test.ts
src/hosts/server-core/session-lifecycle-options.ts
src/hosts/server-core/session-lifecycle.test.ts
src/hosts/server-core/session-lifecycle.ts
src/hosts/server-core/session-metadata-runtime.test.ts
src/hosts/server-core/session-metadata-runtime.ts
src/hosts/server-core/session-presentation-runtime.test.ts
src/hosts/server-core/session-presentation-runtime.ts
src/hosts/server-core/team-runtime.test.ts
src/hosts/server-core/team-runtime.ts
src/main/adapters/__tests__/registry-core.test.ts
src/main/adapters/registry-core.ts
src/main/ipc/__tests__/issues-resolution-create.test.ts
src/main/ipc/__tests__/issues-resolution-handler.test.ts
src/main/ipc/__tests__/issues-resolution-rollback.test.ts
src/main/ipc/__tests__/issues.test.ts
src/main/ipc/__tests__/sessions-file-changes.test.ts
src/main/ipc/issue-resolution-session.ts
src/main/ipc/issues.ts
src/main/ipc/remote-host.ts
src/main/ipc/sessions.ts
src/main/plugin-assets.test.ts
src/main/plugin-assets.ts
src/main/remote-host/index.ts
src/main/remote-host/input-validation-error.ts
src/main/remote-host/input-validation-issues.test.ts
src/main/remote-host/input-validation-issues.ts
src/main/remote-host/input-validation-mutation-authority.ts
src/main/remote-host/input-validation-node-configuration.test.ts
src/main/remote-host/input-validation-node-configuration.ts
src/main/remote-host/input-validation-plan-review.test.ts
src/main/remote-host/input-validation-plan-review.ts
src/main/remote-host/input-validation-profile.ts
src/main/remote-host/input-validation-session-handoff.test.ts
src/main/remote-host/input-validation-session-handoff.ts
src/main/remote-host/input-validation-session-metadata.ts
src/main/remote-host/input-validation-session-presentation.ts
src/main/remote-host/input-validation-teams-usage.test.ts
src/main/remote-host/input-validation-teams-usage.ts
src/main/remote-host/input-validation.test.ts
src/main/remote-host/input-validation.ts
src/main/remote-host/pending-response.test.ts
src/main/remote-host/resource-invalidation.test.ts
src/main/remote-host/resource-invalidation.ts
src/main/remote-host/service-detail-reader.ts
src/main/remote-host/service-issues.test.ts
src/main/remote-host/service-issues.ts
src/main/remote-host/service-lifecycle-races.test.ts
src/main/remote-host/service-node-assets.test.ts
src/main/remote-host/service-node-assets.ts
src/main/remote-host/service-node-configuration.test.ts
src/main/remote-host/service-node-configuration.ts
src/main/remote-host/service-plan-review.test.ts
src/main/remote-host/service-plan-review.ts
src/main/remote-host/service-request-authority.test.ts
src/main/remote-host/service-request-authority.ts
src/main/remote-host/service-scope.ts
src/main/remote-host/service-session-handoff.test.ts
src/main/remote-host/service-session-handoff.ts
src/main/remote-host/service-session-metadata.test.ts
src/main/remote-host/service-session-metadata.ts
src/main/remote-host/service-session-mutations.ts
src/main/remote-host/service-session-presentation.test.ts
src/main/remote-host/service-session-presentation.ts
src/main/remote-host/service-session-state.ts
src/main/remote-host/service-teams-usage.test.ts
src/main/remote-host/service-teams-usage.ts
src/main/remote-host/service.test.ts
src/main/remote-host/service.ts
src/main/session/__tests__/file-change-snapshots.test.ts
src/main/session/__tests__/final-file-diff.test.ts
src/main/session/file-change-path-authority.test.ts
src/main/session/file-change-path-authority.ts
src/main/session/file-change-snapshots.ts
src/main/session/final-file-diff.ts
src/main/session/manager-ingest-pipeline.ts
src/main/store/__tests__/file-change-path-authority-read.test.ts
src/main/store/__tests__/file-change-path-authority.sqlite.test.ts
src/main/store/__tests__/file-change-repo-test-fixture.ts
src/main/store/__tests__/file-change-repo.test.ts
src/main/store/file-change-read-authority.ts
src/main/store/file-change-read-repo.ts
src/main/store/session-repo/__tests__/pin-lifecycle.test.ts
src/main/store/session-repo/index.ts
src/main/store/session-repo/presentation.ts
src/preload/api/issues.ts
src/preload/api/remote-host.ts
src/protocol/control-frame-budget.ts
src/protocol/version.test.ts
src/protocol/version.ts
src/renderer/App.archive-failure.test.tsx
src/renderer/App.tsx
src/renderer/AppWorkspace.remote-parity.test.tsx
src/renderer/AppWorkspace.tsx
src/renderer/app-view-catalog.ts
src/renderer/components/AppHeader.tsx
src/renderer/components/AssetsLibraryDialog.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/DataPanel.tsx
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/IssueDetail.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx
src/renderer/components/RemoteHost/RemoteProfileForm.tsx
src/renderer/components/RemotePendingBucketSection.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionDetail/MessagesPanel.tsx
src/renderer/components/SessionDetail/RemoteEffectivePermissionsView.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/SessionDetail/RemotePendingOutgoingQueue.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.notice.test.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.test.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.tsx
src/renderer/components/SessionDetail/composer-sdk/PendingOutgoingQueue.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/SessionModelDisclosure.tsx
src/renderer/components/SessionModelFields.tsx
src/renderer/components/SettingsDialog.remote.test.tsx
src/renderer/components/SettingsDialog.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/TeamDetail/__tests__/TeamDetail.test.tsx
src/renderer/components/TeamDetail/index.tsx
src/renderer/components/TeamHub.test.tsx
src/renderer/components/TeamHub.tsx
src/renderer/components/__tests__/DataPanel.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.a11y.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/HeaderTokenRates.source.test.tsx
src/renderer/components/__tests__/IssueDetail.forms.test.tsx
src/renderer/components/__tests__/IssuesPanel.membership.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/__tests__/SessionList.parity.test.tsx
src/renderer/components/__tests__/SessionModelFields.test.tsx
src/renderer/components/assets/AssetsTab.test.tsx
src/renderer/components/assets/AssetsTab.tsx
src/renderer/components/assets/BoundedTextPreview.test.tsx
src/renderer/components/assets/BoundedTextPreview.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.tsx
src/renderer/components/assets/ContentViewerModal.tsx
src/renderer/components/assets/RemoteApplicationConventionTab.tsx
src/renderer/components/assets/remote-asset-presentation.ts
src/renderer/components/data-panel/DataPanelView.tsx
src/renderer/components/expandable-content/layer-manager.ts
src/renderer/components/issues/IssueBoard.test.tsx
src/renderer/components/issues/IssueBoard.tsx
src/renderer/components/issues/RemoteIssueResolutionDialog.tsx
src/renderer/components/issues/RemoteIssuesPanel.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/RemoteWorkspaceDirectoryDialog.tsx
src/renderer/components/new-session/session-dialog-actions.ts
src/renderer/components/new-session/session-option-catalog.ts
src/renderer/components/pending-rows/RemotePendingFallbackRow.tsx
src/renderer/components/session-list-tree.ts
src/renderer/components/settings/hook-status-presentation.ts
src/renderer/components/settings/sections/HookSection.tsx
src/renderer/components/settings/sections/LogViewerModal.tsx
src/renderer/components/settings/sections/__tests__/HookSection.test.tsx
src/renderer/components/team-data-source.test.tsx
src/renderer/components/team-data-source.ts
src/renderer/components/use-modal-focus.test.tsx
src/renderer/components/use-modal-focus.ts
src/renderer/hooks/__tests__/use-local-app-bridges.test.tsx
src/renderer/hooks/use-event-bridge.ts
src/renderer/hooks/use-issues-bridge.ts
src/renderer/hooks/use-local-app-bridges.ts
src/renderer/hooks/use-local-session-focus.ts
src/renderer/hooks/use-local-session-state.ts
src/renderer/hooks/use-startup-data-preload.ts
src/renderer/lib/derive-team-role.ts
src/renderer/remote-host/AppHeader.source-mode.test.tsx
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/RemotePageAvailability.test.tsx
src/renderer/remote-host/RemotePageAvailability.tsx
src/renderer/remote-host/RemotePendingRequests.test.tsx
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
src/renderer/remote-host/remote-node-dialog-context.ts
src/renderer/remote-host/remote-plan-review-transports.test.ts
src/renderer/remote-host/remote-plan-review-transports.ts
src/renderer/remote-host/remote-session-actions.authority.test.ts
src/renderer/remote-host/remote-session-actions.ts
src/renderer/remote-host/remote-source-utils.ts
src/renderer/remote-host/session-summary-presentation.test.ts
src/renderer/remote-host/session-summary-presentation.ts
src/renderer/remote-host/source-navigation.test.ts
src/renderer/remote-host/source-navigation.ts
src/renderer/remote-host/source-types.ts
src/renderer/remote-host/use-remote-host-snapshot.test.tsx
src/renderer/remote-host/use-remote-host-snapshot.ts
src/renderer/remote-host/use-remote-pending-hydrator.ts
src/renderer/remote-host/use-remote-presentation-lists.test.tsx
src/renderer/remote-host/use-remote-presentation-lists.ts
src/renderer/remote-host/use-remote-refresh-lane.ts
src/renderer/remote-host/use-remote-session-source-detail.test.tsx
src/renderer/remote-host/use-remote-session-source-isolation.test.tsx
src/renderer/remote-host/use-remote-session-source-test-fixture.ts
src/renderer/remote-host/use-remote-session-source.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/remote-host/use-remote-session-tab-data.ts
src/renderer/remote-host/use-remote-source-context.ts
src/renderer/remote-host/use-remote-usage-source.test.tsx
src/renderer/remote-host/use-remote-usage-source.ts
src/renderer/source-authority.ts
src/shared/file-change-path-authority.ts
src/shared/ipc-channels.ts
src/shared/remote-host/public-errors.ts
src/shared/remote-host/session-request-types.ts
src/shared/remote-host/types.ts
src/shared/types/file.ts
```

## Findings and fixes landed

| Severity | Finding cluster | Resolution |
|---|---|---|
| HIGH | Sensitive file-change, image, asset, and provider-config paths could be read or authorized before canonical/sensitive identity was fully established. | Added descriptor-first and same-handle authorization, post-open dev/inode checks, deny-before-stat traversal, ingestion-time authority binding, all-history final-diff authority matching, deleted-parent reconstruction, and runtime-owned Hook projection state. |
| HIGH | Runtime confirmations, queued settings edits, Local focus admission, and delayed Remote intents could cross session/source/Core-generation authority. | Added execute-time identity/eligibility guards, deferred same-session retry, StrictMode-safe mounted state, fail-closed unknown authority, Local-only bridge admission, exact mutation-authority DTOs, and Main rejection before client selection. |
| HIGH | Normal queued bytes could starve heartbeat control frames and cause otherwise-progressing SSH connections to disconnect. | Added shared control slot/byte reserves and minimum-capacity admission on both client and daemon, with byte-boundary and backpressure regressions. |
| MEDIUM | Profile-wide invalidation and incomplete pagination fencing could over-refresh unrelated resources or merge stale pages into new results. | Added allowlisted per-resource revision lanes, independent one-flight-plus-dirty refresh, and identity/query/cursor/base-revision pagination retirement. |
| MEDIUM | Pending unknown/capability states and legacy page-local lifecycle counts were rendered as authoritative zero/global counts. | Preserved nullable Pending totals, required Pending-index capability, separated legacy global total from unavailable breakdowns, and derived visible counts from accumulated rows. |
| MEDIUM | Provider/model/thinking summaries, effective permissions, adapter readiness, and session creation catalog wiring could present fabricated or unavailable state. | Render disabled fields as unavailable, preserve provider defaults only for enabled fields, project explicit network/sandbox decisions, gate on registry readiness, and ship bounded catalog wiring. |
| MEDIUM | Modal focus, Escape priority, handoff isolation, and narrow Issues layout could permit background interaction or inaccessible navigation. | Added shared modal focus semantics, focus restoration, nested-layer Escape handling, commit blocking, stale-preview fencing, and a stacked narrow master/detail layout. |
| LOW/INFO | Stale snapshot errors, Remote pinned parity, dead helpers, notice tone, and several test/config boundaries were incomplete. | Cleared accepted refresh errors, added read-only pin state, removed dead helpers/contracts, separated neutral notices from failures, and updated deterministic fixtures. Record-only fail-closed tradeoffs remain documented below. |

No accepted CRITICAL finding was reported. The paired final I1 correction review found no new
CRITICAL, HIGH, MEDIUM, LOW, or INFO issue, and both reviewers recommended convergence.

## Deep-risk evidence

- Protocol negotiation preserves Node Configuration at 2.2/2.3 while gating new safe projection
  and presentation surfaces at 2.4. Strict DTO parsing remains synchronized across Core, Main,
  preload, and Renderer.
- Unknown, offline, reconnecting, snapshot-error, and Core-generation transitions retire readers,
  in-flight results, pagination, and mutation authority without falling back to Local.
- Every Renderer-exposed Remote mutation carries the captured authoritative Core id and Worker
  generation. Main validates exact keys and values and rejects a stale scope before `getClient`.
- Resource events map through a bounded allowlist to isolated list/detail/Pending/Team/Issue/usage
  lanes; unknown event kinds fail safe to the complete invalidation set.
- Sensitive values, generic absolute paths, provider token prefixes, and deceptive structured keys
  are redacted centrally. File/asset reads do not reopen a path after authority is established.
- Runtime controls serialize intent, recheck origin at drain time, retry only while the same
  identity becomes eligible, and never write during an unmount or replacement-session cleanup.

## Validation and evidence

- Full Electron-as-Node: 943 files / 6,043 tests passed; three explicit live/environment tests
  skipped.
- Final I1 correction review: reviewer-codex 22 files / 117 tests; reviewer-claude 26 files /
  154 tests; all passed.
- Earlier focused convergence sweeps covered transport, Core security, file-history SQLite, source
  isolation, pagination, runtime controls, modal accessibility, Teams, Issues, Data, and package
  configuration with deterministic negative and race fixtures.
- `pnpm typecheck`, direct Node/Web TypeScript, architecture, Core/Node boundary, production build,
  Linux headless verification, deployment automation, Relay and Full static checks, `git diff
  --check`, file-size gates, and file-level review expiry passed.
- macOS Worker sandbox and bundled-runtime validation passed before the final Renderer/Main-only
  mutation-authority correction; those artifact boundaries were unchanged by the correction.

## Residual risk

- Live desktop/Worker/deployment acceptance was deliberately excluded from read-only review and
  remains a T9 gate after a clean pushed commit and user-installed package.
- Legacy file-change rows without captured authority and identity-failed ingestion rows are hidden
  from Remote final diff while Local recorded history remains available. This is an intentional
  fail-closed compatibility tradeoff.
- A model edit queued behind another runtime IPC can be discarded on a true unmount without a
  visible notice because the component no longer exists. The mounted/identity fence intentionally
  prefers zero stale mutation; normal navigation flushes on blur.

## Follow-ups

1. Commit and push the exact reviewed release.
2. Build the macOS package from that clean pushed commit; the user installs it.
3. Run non-invasive installed acceptance for connection/reconnect, all page groups, lifecycle,
   sensitive-file exclusions, and real Claude/Codex sessions.
