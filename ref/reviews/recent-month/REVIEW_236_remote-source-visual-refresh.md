---
review_id: 236
reviewed_at: 2026-08-12
baseline_commit: 3a04af5e8a32a6183f49711159de0575464abf4e
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record, changelog, rebucketing, and index maintenance are mechanical."
---

# REVIEW_236_remote-source-visual-refresh: Remote source visual hierarchy

## Scope and method

This review checked the Remote source manager's visual hierarchy, action semantics, keyboard and
screen-reader affordances, long-content containment, and source-authority wording. It also verified
that the change is styling-only and leaves the existing selection and connection callbacks intact.

```review-scope
src/renderer/components/RemoteHost/RemoteConnectionCards.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx
src/renderer/components/RemoteHost/RemoteProfileForm.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| LOW | `selectedRemoteProfileId` persists while the application is in Local mode, so labeling the highlighted card as the “current source” would overstate its authority. | Label the highlight `默认连接`: it accurately identifies the Remote profile that will be used without implying that Remote mode is active. The manager continues to state that source mode is selected from the top menu. |

## Validation and evidence

- The selected profile uses a blue accent and a text badge; connection health uses independent
  text-labelled green, amber, red, or neutral pills. The status meaning does not rely on color alone.
- The selectable profile summary remains one button, while connect/disconnect, edit, and delete
  remain separate buttons with their existing callbacks and disabled states.
- Existing focus trapping, close behavior, long-label truncation, long-error wrapping, scrolling,
  empty-state, confirmed deletion, and recoverable Worker-offline tests remain green.
- Focused Remote manager/dialog coverage passed 2 files / 23 tests.
- The complete `pnpm test` suite passed 944 files / 6,053 tests, with 2 files / 3 conditional skips.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.

## Residual risk

- Exact color appearance still depends on the macOS vibrancy and transparent-window setting. The
  new surfaces use the application's established translucent palette and preserve text labels so
  meaning remains clear if contrast varies slightly with the desktop background.
- No installed runtime was restarted during this session because it owns the active Agent Deck
  conversation. The renderer-only change will be visible after the normal build/install refresh.

## Verdict

PASS. The gray connection tiles are replaced with a source-aware glass hierarchy, actions and
status remain accessible and behaviorally unchanged, and the only review finding was resolved.
