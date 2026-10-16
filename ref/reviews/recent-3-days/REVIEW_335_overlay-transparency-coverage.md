---
review_id: 335
reviewed_at: 2026-10-16
baseline_commit: 523e8ef81e0dc5b576a320a61f8f12a760d44a56
expired: false
---

# Overlay transparency coverage

## Scope and method

Lead-owned follow-up inspection of all renderer popup entry points, background styles and portals
for the owner's transparency request. No delegation or independent paired review was performed.
The existing expiry helper stopped during legacy scope mapping with exit 1; every path listed
below was inspected directly, including previously unknown coverage. This is a styling audit,
not a renewal of unrelated runtime or provider review coverage.

```review-scope
src/renderer/styles/globals.css
src/renderer/styles/globals.test.ts
src/renderer/components/FloatingFrame.tsx
src/renderer/components/DeckSelect.tsx
src/renderer/components/assets/ProviderCombobox.tsx
src/renderer/components/SessionActionsContextMenu.tsx
src/renderer/components/HistorySessionActionsMenu.tsx
src/renderer/components/pending-rows/PlanQuoteContextMenu.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/pending-rows/diff-review-presentation.tsx
src/renderer/components/expandable-content/ExpandableContent.tsx
src/renderer/components/expandable-content/__tests__/ExpandableContent.test.tsx
src/renderer/components/SessionDetail/composer-sdk/ExpandedComposerOverlay.tsx
src/renderer/components/SessionDetail/composer-sdk/SlashCommandMenu.tsx
src/renderer/components/diff/ExpandedDiffOverlay.tsx
src/renderer/components/diff/renderers/MonacoDiffView.tsx
src/renderer/components/diff/renderers/MonacoDiffEditor.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.tsx
src/renderer/components/native-work/NativeWorkCard.tsx
src/renderer/components/native-work/native-work.css
src/renderer/components/SettingsDialog.tsx
src/renderer/components/ConfirmationDialog.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/RemoteWorkspaceDirectoryDialog.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/assets/ContentViewerModal.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx
src/renderer/components/RemoteHost/RemoteProfileForm.tsx
src/renderer/components/hand-off/HandOffDialogFrame.tsx
src/renderer/components/settings/sections/LogViewerModal.tsx
src/renderer/components/ImageLightbox.tsx
```

## Findings and fixes

1. **LOW — Incomplete mode coverage.** Read-only expansion, select/provider menus and session/quote
   menus still used the same translucent base in both modes. They now retain their original base
   in ordinary mode and apply the shared surface multiplier in transparent mode. The subagent
   drag preview also follows the shared multiplier. Two existing expansion tests needed their
   surface assertions aligned, including the new-session input consumer missed by the initial
   seven-file test selection.
2. **LOW — Compounded plan background.** The plan-review overlay stacked a 0.78 background behind
   its new 0.94 panel, producing approximately 0.987 combined alpha. Remove the redundant outer
   background; the inner surface fills the viewport and ordinary mode remains visually solid.
3. **LOW — Opaque nested content.** Real log/diff editors still painted opaque Monaco backgrounds
   inside the changed popup. Scoped CSS retains one theme-colored base at 0.94 and clears only
   duplicate editor-content/gutter backgrounds. Foreground opacity, syntax and diff decorations
   remain intact. Plain diff/conflict panes use their original base with the same popup-only rule.
   Inline editor/content backgrounds are outside this rule.

## Surface inventory and evidence

| Surface family | Inspection and Browser evidence |
|---|---|
| Shared dialogs | All 11 `deck-dialog-surface` consumers checked. Settings, new session, resource content, remote connection, handoff and confirmation opened with production components and synthetic data. |
| Body portals and nested dialogs | Confirmation, settings/logs and new-session/input verified outside the frame. Root inheritance reaches them; closing the child restores its parent. |
| Fullscreen panels | Read-only expansion, expanded input, plan review and diff inspected. Plan inner/outer bounds both matched the viewport after removing the extra background. |
| Menus | Select, provider, session-context and plan-quote menus opened. Select/read-only/context/quote backgrounds measured in both modes; slash-command menu uses the shared mode token. |
| Subagent details | Shared Local/Remote component and drag-preview styling checked. Detail background measured at 0.94 with text opacity 1. |
| Editor contents | Real bundled Monaco diff/log editors opened in both modes. Base retained RGB 30/30/30; transparent mode alpha 0.94 with duplicate backgrounds cleared. Foreground remained RGB 212/212/212 at opacity 1. |
| Images and embedded pages | Image lightbox already has a translucent black dimmer; sample image opacity remained 1. Image pixels, embedded web pages, native file pickers and browser-owned tooltips keep their own rendering. |

Ordinary solid surfaces use alpha 1; existing softer surfaces retain approximately 0.78 rather
than becoming more opaque. Transparent softer surfaces measured approximately 0.734. Original
RGB colors, borders and control/text opacity remain unchanged. The prototype uses its neutral
background without added gradients. Screenshots of settings, plan review, diff and nested logs
were inspected; Browser console capture was empty.

## Validation

- `pnpm typecheck` passed, including architecture boundaries.
- `pnpm test src/renderer`: 1,182 passed across 182 files.
- `pnpm build` passed; the shared Electron native binding hash stayed unchanged.
- `git diff --check`, changed-source 500-line guard, record links/routing and added-content
  privacy checks passed. README remains unchanged and concise.
- Moved REVIEW_318 and REVIEW_319 to their current time bucket without changing their content;
  repaired incoming plan links and bucket indexes.

## Residual risk and follow-up

Browser verification used the session-scoped bundled CLI and production renderer components
with synthetic data. It establishes Chromium styles and representative interactions, not native
desktop compositing, live remote transport, actual settings writes or provider execution.
Shared-dialog consumers were source-inspected and covered by renderer tests; their complete
business workflows were not each repeated in Browser. The Monaco overrides intentionally target
its current background layers and should be rechecked after editor upgrades.

Preview controls and raw measurements remain intentionally non-final under
`.ref/prototypes/native-work-production/`; the tab remains open on transparent-mode settings.
No host restart, packaging, installation or remote push occurred in this follow-up.
