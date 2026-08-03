---
review_id: 190
reviewed_at: 2026-07-29
baseline_commit: 15537b6b206b2d26aa5b1c4c18b9f722cae75d44
expired: false
---

# REVIEW_190_first-message-image-control-spacing: Compact image control spacing

## Scope

Investigate and fix the excessive vertical separation between the new-session first-message input
and its compact image upload control.

```review-scope
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/hand-off/ExpandableTextSurface.tsx
src/renderer/components/new-session/FirstMessageAuthoring.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| LOW | The character counter occupied a dedicated row inside the shared authoring field, while the image control occupied another row below it. The two stacked rows made the upload button appear detached from the textarea. | Added a compact action slot to the authoring-field footer, placed the image control beside the counter, and retained one natural `space-y-1` gap below the block-level textarea. |

## Evidence

- The reported screenshot showed the counter between the textarea and a separately rendered image
  row.
- An isolated renderer preview confirmed the image control and character counter now share one
  footer row with a 4px gap below the textarea.
- The regression test asserts that both controls share the same footer and that the textarea is
  block-level, preventing browser baseline whitespace from enlarging the intended spacing.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.

## Validation

- `pnpm typecheck` passed.
- Full Electron-ABI suite passed: 468 files passed, one skipped; 4,000 tests passed, one skipped.
- `git diff --check` passed before the final review record was added.
- All changed source and test files remain below the 500-line guardrail.

## Fixes landed

- `ExpandableAuthoringField` accepts compact footer actions and aligns them with its character
  counter.
- The new-session image upload control now uses that footer slot; attachment thumbnails remain in
  their own conditional row.
- Textareas render as blocks, so the intended spacing is not inflated by inline baseline descent.

## Residual risk

None identified. The shared block-level textarea change removes only inline formatting whitespace;
existing sizing, resizing, and expanded-editor behavior remain covered by the full suite.

## Follow-up

None.
