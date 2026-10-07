---
review_id: 314
reviewed_at: 2026-10-03
baseline_commit: de9562c9ff3914fda3e78654eca9c7b397ee5015
expired: false
---

# File-operation cards across adapters

## Scope

Bounded debugging of duplicate Claude file-edit activity rows and alignment of Claude, Codex,
and Grok file-operation cards, including the related Monaco teardown error found during visual
verification. This is a local engineering inspection, not an independent paired
review. The review-expiry script was run; unrelated expired coverage receives no exemption.

```review-scope
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/activity-feed/file-change-row.test.tsx
src/renderer/components/activity-feed/rows/file-change-details.tsx
src/renderer/components/activity-feed/rows/file-change-row.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/tool-call-presentation.ts
src/renderer/components/activity-feed/tool-file-change-presentation.test.tsx
src/renderer/components/diff/renderers/MonacoDiffEditor.tsx
src/renderer/components/diff/renderers/MonacoDiffView.tsx
src/renderer/components/diff/renderers/MonacoDiffView.lifecycle.test.tsx
src/renderer/components/diff/renderers/MonacoDiffView.readiness.test.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx
```

## Findings and fixes

1. A completed Claude Edit, Write, or MultiEdit produces both a tool result and a recorded file
   change. The activity view rendered both as separate cards, with duplicate diff disclosures.
   Associate them by session, adapter, and provider call ID, then render one tool card with its
   recorded changes. Grok ACP file operations use the same fix.
2. Codex file-change items can lack a tool envelope. Group their files by provider call and reuse
   the same card, status, timestamp, and recorded-diff controls. Missing historical starts also
   retain this presentation. Preserve provider-specific tool names and available output without
   inventing output for standalone changes.
3. Keep independent edits to the same path separate. Uncorrelated changes and changes associated
   with suppressed SDK question/plan tools remain visible. No persistence, adapter event, or
   Changes-tab history is discarded.
4. Reuse stored full comparisons, source-owned lazy reads, retry/loading behavior, image access,
   and enlargement. Recorded changes take precedence over the tool-input snippet preview.
   Read/Bash start/end pairing, failure output, and Claude message-display consolidation retain
   their existing regression coverage.
5. Closing an enlarged modification disposed its text models before the diff editor detached,
   triggering Monaco's `TextModel got disposed before DiffEditorWidget model got reset` guard.
   Replace the React wrapper's diff lifecycle with a small lazy native editor owner. Each view
   creates private models, detaches them, disposes its editor, then releases the models. Partial
   initialization failures use the same cleanup. Keep readiness activation in the layout phase
   so StrictMode replay activates the view before native initialization runs.

## Validation

- Before the fix, 11 of the initial 16 new regression cases failed, reproducing duplicate cards.
- Final activity-feed suite: 13 files / 102 tests passed, including 18 new cases.
- The original wrapper failed 4 of the first 5 lifecycle regressions with the same teardown
  violation. Final activity/diff suite: 16 files / 128 tests passed, including 8 lifecycle cases
  covering close buttons, Escape, repeated reopening, replacement content/language, StrictMode,
  immediate unmount, and partial initialization failures.
- `mise exec -- pnpm typecheck` passed, including both architecture checks.
- Final `mise exec -- pnpm test`: 1,133 files / 7,052 tests passed; 3 files / 6 conditional skips.
- The Electron SQLite binding checksum was unchanged before and after the full suite.
- Agent Deck Browser used a temporary local fixture importing the actual activity and diff
  components. Claude Edit/Write, Codex standalone changes, and Grok multi-file changes shared
  identical card classes. Each operation had one card; each file had one diff disclosure.
  Real Monaco modification rendering, whole-file additions, output disclosure, and enlargement
  were exercised. The 420px fixture had no horizontal overflow. Both background tabs were closed.
- A second Browser fixture exercised the actual native Monaco editor and overlay after the
  lifecycle repair. Model counts followed 0 -> 2 -> 4 -> 2 -> 4 -> 2 -> 0 across inline expansion,
  enlargement, Escape, reopening, close-button dismissal, and collapse. Reopening and unmounting
  the activity list also returned to zero models/editors. Console capture and window error
  collection remained empty. The enlarged diff was visually inspected and the tab was closed.
- `git diff --check`, source-file size, path privacy, and changed record links were checked.

## Residual risk and follow-up

The reported Monaco lifecycle issue was included in this delivery at the user's request and
resolved in source. Browser validation used synthetic local data with the real renderer and
editor, rather than a paid provider conversation or a replacement of the running app.

All changed source/test files remain below 500 lines. This is a renderer-only source repair;
no running application or installed bundle was replaced. README.md was left untouched as
requested. Final records were rebucketed and their links updated under the repository policy.
