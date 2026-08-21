---
changelog_id: 622
changed_at: 2026-08-20
---

# CHANGELOG_622_global-stable-action-presentation: Keep action controls globally stable

## Summary

Dynamic action buttons across the renderer now reserve one stable intrinsic size for every label
and icon state. Session configuration surfaces also separate functional interaction blocking from
their visible 150 ms presentation, while delayed progress occupies an existing footer slot instead
of moving the action row.

## Changes

### Shared stable button content

- Added one accessible intrinsic-grid presentation that overlays all declared button variants.
  Hidden variants continue sizing the button but are removed from the accessibility tree; only the
  active label is announced.
- Applied it to 22 production consumers covering new-session directory/create actions, Local and
  Remote handoff, Local and Remote composers, archive retry, Issues, Diff, IAB annotation, plan
  review, summary/tool toggles, Remote profile saving, Hook management, Grok authentication, and
  log refresh.
- Reserved icon-bearing and text-only states together, so busy labels, refresh labels, steer modes,
  and status transitions cannot resize their button or move adjacent controls.

### 150 ms presentation consistency

- Keep the selected assistant control interactive while the previous adapter projection is held.
- Put model/runtime controls behind an inert interaction boundary during the grace period. They
  remain functionally unavailable without acquiring native disabled opacity or changing the
  settled visual projection.
- Apply the same separation to Remote handoff model/runtime controls and retain the last settled
  visual state of its prepare and commit actions until the target loading projection is released.
- Move delayed configuration progress into the existing Local/Remote footer flex slot. Its
  appearance no longer adds a form row or changes the vertical position of the action buttons.

## Validation

- Focused renderer coverage: 23 files / 168 tests passed.
- `pnpm typecheck`
- `pnpm test`: 996 files passed and 2 skipped; 6,243 tests passed and 3 skipped.
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

No exception is required. Every changed production TypeScript file remains below 500 lines. The
largest is `src/renderer/components/HandOffPreviewDialog.tsx` at 495 lines; this change only adds a
small shared-content call site there, and any future behavior growth must be extracted first.

## Notes

- This is renderer-only bug fixing and presentation consistency; no README workflow change or new
  user-facing copy is required.
- The installed application still requires packaging/restart before live acceptance.

## Related review

- `ref/reviews/recent-3-days/REVIEW_259_global-action-layout-stability.md`
