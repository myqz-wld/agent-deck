---
review_id: 298
reviewed_at: 2026-09-29
baseline_commit: 5c4b8857b02e1c497370ca2777bd6143ab2341e1
expired: false
---

# Application dialog inventory and quota-reset safety

## Scope

Direct inspection and regression validation of the user's requested changes.
This is a solo implementation audit, not a paired review. Prior review coverage
was not treated as an exemption. The expiry helper was attempted but stopped
while emitting historical mappings; a scoped Git-based audit classified 89
changed source/test files: 20 unreviewed, 33 expired, and 36 previously covered.

```review-scope
src/contracts/usage-reset.ts
src/contracts/usage-reset.test.ts
src/contracts/usage.ts
src/contracts/methods.ts
src/contracts/grant-policy.ts
src/main/adapters/provider-usage.ts
src/main/adapters/provider-usage-reset.ts
src/main/adapters/codex-cli/usage-reset.ts
src/main/adapters/codex-cli/usage-reset.test.ts
src/main/adapters/codex-cli/usage-probe-store.ts
src/main/adapters/codex-cli/usage-snapshot-core.ts
src/main/ipc/provider-usage.ts
src/main/remote-host/service-usage.ts
src/main/remote-host/input-validation-usage.ts
src/hosts/server-core/usage-runtime.ts
src/renderer/lib/confirm-dialog.ts
src/renderer/components/ConfirmationDialog.tsx
src/renderer/components/ConfirmationDialog.test.tsx
src/renderer/components/data-panel/ProviderUsageReset.tsx
src/renderer/components/data-panel/ProviderUsageReset.test.tsx
src/renderer/components/data-panel/DataPanelView.tsx
src/renderer/components/DataPanel.tsx
src/renderer/stores/usage-reset-store.ts
src/renderer/remote-host/use-remote-usage-source.ts
src/renderer/components/ImageLightbox.tsx
src/renderer/components/diff/ExpandedDiffOverlay.tsx
src/renderer/components/SessionDetail/composer-sdk/ExpandedComposerOverlay.tsx
src/renderer/components/SessionDetail/composer-sdk/SessionSandboxControls.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/use-modal-focus.ts
src/renderer/components/expandable-content/layer-manager.ts
src/renderer/styles/globals.css
```

## Dialog inventory

| Category | Entry points | Disposition |
|---|---|---|
| Simple confirmations | Session/history deletion, remote profile removal, settings/convention reset, discard changes, permission/sandbox changes, plan approval, quota resets | One queued compact application dialog; explicit action and Cancel; destructive color preserved |
| Form/content frames | New session, remote workspace directory, handoff, settings, assets library, content viewer, bundled runtime editor, remote host manager, remote profile form, logs | Shared background, border, radius and backdrop; preserve usable content dimensions |
| Full-screen editors/viewers | Expanded content, plan review, composer, diff | Preserve full-screen content layouts and use common modal focus/layer behavior |
| Image preview | Image lightbox | Preserve media presentation; register with common modal layers |
| Menus/popovers | Select, command, session-action and plan-quote menus | Retain menu semantics and existing layouts; nested Escape remains layered |
| OS-owned dialogs | File/directory selection and pre-renderer fatal errors | Retain native dialogs, including when the renderer cannot start |

## Findings and resolutions

- **MEDIUM, fixed:** independent image/diff/composer Escape handlers and focus
  isolation could conflict with a newly nested application confirmation. Reuse
  `useModalFocus` and the shared layer stack; preserve initial editor/image focus.
- **MEDIUM, fixed during validation:** inserting a new Remote grant in the middle
  of the product list broke the compact grant's ordered round trip. Append the
  new operation consistently and keep existing method bit positions unchanged.
- Reset checks cover account mismatch before consumption, duplicate request
  coalescing, overlapping-attempt rejection, stable retries after a lost response,
  Remote authority/grant checks, and late pre-reset reads not replacing fresh data.
- Confirmation checks cover cancellation, source unmount, queued callers,
  nested Escape, focus restoration, and positive/zero/unknown count states.

## Evidence

- `pnpm typecheck` and `pnpm build` passed.
- Full Electron suite: 1,094 files, 6,758 passing tests, 3 pending, no failures.
- Real provider GET/usage reads established the count contract. Consumption was
  validated with synthetic responses only.
- Agent Deck Browser exercised actual React quota/confirmation components with
  mock callbacks: 10px count copy, a single compact row, cancel, simulated success,
  and destructive confirmation. Console capture was empty; network capture had
  only local preview assets.

## Residual risk and activation

Live redemption and OS runtime-setting mutations were intentionally not executed.
The backend remains authoritative about reset eligibility and resulting windows.
Unresolved attempt keys survive view remounts in renderer memory; they are not
persisted across application restarts. Main/preload changes require a restart.
No application restart, installation, or deployment was performed.

Related: [CHANGELOG_658](../../changelogs/recent-week/CHANGELOG_658_codex-resets-dialogs.md).
