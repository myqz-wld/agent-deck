---
review_id: 285
reviewed_at: 2026-09-29
baseline_commit: 11ee10afb951ce3baf6c945abfe95cfcde078cfd
expired: true
---

# UI Icons and Lightbox Interaction Review

## Scope and method

Follow up the user's Live-tab omission report, request to handle other emoji icons, and image-save
control feedback. This is lead source inspection, regression tests, and synthetic Browser visual
validation. It is not an independent paired review; coverage remains expired for future review.

The expanded inventory found 222 matches in 69 non-test source files, including 15 renderer files.
Many non-renderer matches are comments, stored message content, or protocol-related recovery text.
Only UI-owned decorations are converted; authored messages and protocol data are preserved.

```review-scope
src/renderer/components/DeckSelect.tsx
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/ImageLightbox.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/SessionActivityLine.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.test.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.runtime.test.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/__tests__/SessionSandboxControls.test.tsx
src/renderer/components/SessionDetail/composer-sdk/ErrorBanner.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/__tests__/ImageLightbox.test.tsx
src/renderer/components/activity-feed/activity-icon.tsx
src/renderer/components/activity-feed/describe.test.ts
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/records-view.test.tsx
src/renderer/components/activity-feed/rows/event-images.tsx
src/renderer/components/activity-feed/rows/simple-row.tsx
src/renderer/components/activity-feed/tool-icon.tsx
src/renderer/components/activity-feed/tool-icons.ts
src/renderer/components/activity-feed/turn-outcome.ts
src/renderer/components/icons/actions.tsx
src/renderer/components/icons/content.tsx
src/renderer/components/new-session/FirstMessageAuthoring.tsx
src/renderer/components/new-session/remote-sandbox-options.ts
src/renderer/components/pending-rows/AskRow.tsx
src/renderer/components/pending-rows/DiffReviewRow.tsx
src/renderer/components/pending-rows/ExitPlanRow.test.tsx
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/pending-rows/PendingStatusIcon.tsx
src/renderer/components/pending-rows/PermissionRow.tsx
src/renderer/components/session-live-activity.ts
src/renderer/components/settings/sections/ExperimentalSection.tsx
src/renderer/hooks/useLightboxControls.ts
src/renderer/lib/__tests__/sandbox-options.test.ts
src/renderer/lib/sandbox-options.ts
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
```

## Findings and fixes

- LOW: Live cards kept their own emoji formatter and stale Shell/Grok summaries. Extract structured
  activity presentation and reuse the shared SVG tool selector and input formatter.
- MEDIUM: Live completion shortcuts showed a success tick for failed or interrupted rounds. Use
  the actual latest completion event and the same outcome formatter as session detail.
- LOW: Pending dialogs, errors, summary triggers, and sandbox labels mixed emoji with SVG chrome.
  Replace decorations and move dropdown warning state into explicit metadata. Keep existing texts,
  runtime values, source authority, approval gates, keyboard controls, and callbacks.
- LOW: Image-save actions lacked hover/pressed feedback and obscured the lower-left image region
  continuously. Add interaction styles and bottom-centered auto-hiding controls, with explicit
  hover, keyboard, and saving holds. Hidden actions ignore pointer events but remain keyboard
  reachable; the dialog retains Escape dismissal and restores the previous focus on unmount.

## Validation

- `pnpm typecheck` passed, including both architecture guards and TypeScript projects.
- Final full `pnpm test`: 1,058 files / 6,525 tests passed; 2 files / 3 opt-in tests skipped.
- The targeted icon/pending/composer batch passed 173 tests. Image-control, image-save UI, and
  attachment regressions passed 14 tests; the split composer suites preserved all 25 cases.
- `pnpm build` passed for main, preload, and renderer. The Electron SQLite binding checksum
  remained unchanged; no dependency install or native binding rebuild was performed.
- Browser rendered actual Local/Remote cards, pending rows, and dropdowns with synthetic data.
  Screenshots confirmed semantic icons, warning accents, alignment, and concise Browser/Grok
  summaries. The 420px viewport had a matching 420px page width. Dropdown selection still worked.
- A second Browser pass checked the image lightbox: idle controls reached opacity 0 with pointer
  events disabled, Tab revealed them, saving remained visible, and screenshots confirmed the
  unobstructed image and bottom-centered action bar. Saving used a mock callback in this preview.
- The non-test renderer source scan found no remaining Extended_Pictographic characters. This
  checks built-in source decorations, not arbitrary user/model/provider message contents.
- Diff whitespace, local links, identifying-path/token scan, 500-line limits, and record buckets
  were checked. The only Browser tabs used for this task were closed after verification.

## Residual risk and boundaries

- Raw messages may legitimately contain emoji. This change does not rewrite user/model content,
  provider recovery messages, historical events, or durable runtime/prompt assets.
- Browser verification used real renderer components with synthetic sessions and mocked saving;
  it did not change permissions or save a file through the running application's native dialog.
- Tests cover the idle timer, pointer reveal/hover hold, saving/completion, and keyboard focus.
  Hover/pressed styles use CSS states; scripted Browser key delivery cannot fully represent every
  native pointer/input modality.
- No running Agent Deck process or installed bundle was changed. Unrelated Relay documentation
  edits committed during this work were preserved.

## Follow-ups

No required implementation remains. See [CHANGELOG_653](../../changelogs/recent-week/CHANGELOG_653_ui-icons-lightbox-controls.md).
