---
changelog_id: 424
changed_at: 2026-07-31
---

# CHANGELOG_424_plan-review-expandable-inputs: Expandable plan review inputs

## Summary

The plan deep-review question and revision-feedback fields now use consistent top-right expand
actions instead of native drag-resize handles. Both expanded editors share live draft state with
their compact fields.

## Changes

### Plan deep-review dialog

- Replace vertical drag resizing on both editable text fields with `resize-none` compact surfaces.
- Add the shared input-sized expand action to the question and revision-feedback fields.
- Preserve draft edits, disabled state, keyboard submission, focus refs, and accessible labels in
  compact and expanded views.

### Regression coverage

- Assert that both compact fields are non-resizable and expose their top-right expand actions.
- Verify question text remains synchronized while opening, editing, and closing the expanded view.
- Verify the revision-feedback expanded editor is available from its compact field.

## Validation

- `pnpm exec vitest run src/renderer/components/pending-rows/PlanDeepReviewDialog.test.tsx`
  (19 tests passed).
- `pnpm exec tsc --noEmit -p tsconfig.web.json`.
- Full `pnpm typecheck` remains blocked by pre-existing main-process worktree and hand-off test
  type drift in the dirty worktree; renderer type checking passes.
- Full `pnpm test` reached 417 passing files and 3,506 passing tests, but remains blocked by 20
  pre-existing failing main-process files in the dirty worktree.

## Do Not Split Protection

All changed production source files remain below 500 lines.

## Notes

- This is renderer-only, so the running development app can receive the change through HMR.
- README remains unchanged because it does not document the plan deep-review dialog's field-level
  controls.
