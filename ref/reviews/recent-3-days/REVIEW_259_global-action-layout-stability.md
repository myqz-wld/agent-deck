---
review_id: 259
reviewed_at: 2026-08-20
baseline_commit: 183e108a2172ecf5082cce99b933ba6e17c0b17b
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final global audit records and bucket indexes are mechanical evidence added after implementation."
---

# REVIEW_259_global-action-layout-stability: Global dynamic-action and 150 ms audit

## Scope and method

This follow-up audited all renderer `<button>` sites, conditional busy/loading labels, indirect
Composer action labels, icon changes, and every active use of the shared 150 ms readiness policy.
It distinguished text-only status content and fixed-width selectors from auto-width action controls,
then traced Local/Remote new-session, issue-resolution, and handoff interaction authority. The
repository review-expiry report was run before implementation.

```review-scope
src/renderer/AppArchiveFailureBanner.tsx
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/InertInteractionBoundary.tsx
src/renderer/components/RemoteHost/RemoteProfileForm.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/DiffTab.tsx
src/renderer/components/SessionDetail/IabAnnotationCanvas.tsx
src/renderer/components/SessionDetail/IabPanel.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/SessionComposerView.tsx
src/renderer/components/SessionDetail/composer-sdk/ExpandedComposerOverlay.tsx
src/renderer/components/StableButtonContent.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/__tests__/InertInteractionBoundary.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/StableButtonContent.test.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/hand-off/HandOffDialogFrame.tsx
src/renderer/components/issues/IssueBoard.tsx
src/renderer/components/issues/IssueResolutionControls.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/RemoteWorkspaceDirectoryDialog.tsx
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/pending-rows/PlanReviewDecisionFooter.tsx
src/renderer/components/settings/sections/GrokAuthenticationSection.tsx
src/renderer/components/settings/sections/HookSection.tsx
src/renderer/components/settings/sections/LogViewerModal.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Auto-width buttons across creation, handoff, Composer, Diff, Issues, IAB, plan review, and settings replaced short labels/icons with longer busy or status content, moving sibling controls even when their outer layout was otherwise stable. | Add one `StableButtonContent` intrinsic grid and migrate every audited dynamic action. All variants size one grid cell; inactive variants are invisible and `aria-hidden`. |
| MEDIUM | The 150 ms adapter projection retained old values but immediately passed native `disabled` to those old model/runtime controls. They visibly faded before the target projection was allowed to appear. Remote handoff also folded `remote.loading` directly into its visual `busy` state. | Use an inert boundary to preserve appearance while preventing interaction. Keep Remote handoff operational busy separate from configuration loading, and retain its last settled prepare/commit appearance through the grace. |
| MEDIUM | Delayed configuration progress mounted as a new flex child above the action row, so crossing 150 ms moved the create/handoff buttons vertically. | Render progress in the existing footer's flexible left slot. The footer height and right-aligned action geometry remain constant. |
| LOW | Several non-busy state controls—summary expansion, tool diff expansion, issue resolution replacement, and Hook lifecycle—could still resize after the initial async-label sweep. | Include their complete state sets in the same shared stable-content boundary. |

## Validation and evidence

- Shared-component coverage proves inactive labels continue to exist for intrinsic sizing while only
  the active label remains accessible. The inert-boundary test proves child controls retain native
  enabled presentation while the wrapper owns interaction blocking.
- New-session timing coverage proves the held model input remains visually enabled inside an inert
  boundary through a fast Codex switch, then becomes ordinary target content atomically.
- Remote handoff coverage proves the same behavior and confirms delayed progress is rendered in
  the footer rather than as a body row.
- Focused renderer validation passed 23 files / 168 tests across Local/Remote creation, handoff,
  Composer, IAB, plan review, Issues, summary, tools, settings, and shared primitives.
- `pnpm typecheck` passed architecture, Core Node, and TypeScript checks.
- `pnpm test` passed 996 files and 6,243 tests; 2 files and 3 opt-in tests were skipped.
- `pnpm build` passed main, preload, renderer, and build-info generation.
- `git diff --check`, review-scope coverage, bucket/index parity, and the 500-line production-source
  guard passed.

## Residual risk

- Stable variants must be declared when a future button introduces a new label state. The shared
  component safely falls back to the first variant for an unknown key, and its focused test makes
  the sizing/accessibility contract explicit.
- Adapter-specific target controls may legitimately change the form's final height when the target
  projection is committed. The fix removes intermediate and status-induced movement; it does not
  force different adapter schemas into an artificial identical layout.
- Installed-app acceptance remains pending packaging and restart.

## Verdict

PASS. All dynamic action sites found by the global renderer audit use stable intrinsic content, and
the active 150 ms configuration surfaces no longer mutate old controls or action-row geometry
before the presentation boundary.
