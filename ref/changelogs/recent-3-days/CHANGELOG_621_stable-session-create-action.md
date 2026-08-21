---
changelog_id: 621
changed_at: 2026-08-20
---

# CHANGELOG_621_stable-session-create-action: Stabilize the session creation action

## Summary

The session creation button now follows the same 150 ms presentation boundary as the model
projection. Fast configuration revalidation leaves the button visually unchanged, and every
button state reserves stable intrinsic width so status text cannot move the surrounding actions.

## Changes

- Keep the ordinary create label during configuration revalidation instead of replacing it
  immediately with `正在准备…`.
- Retain the last settled enabled/disabled appearance during the first 150 ms while continuing to
  block submission against unresolved target authority.
- Apply the disabled appearance only when the delayed configuration progress becomes visible at
  the 150 ms boundary, or when the settled form is genuinely not creatable.
- Reserve the maximum intrinsic width of the idle label with its icon and the creating label in one
  overlaid grid, preventing layout movement when an actual create request starts.
- Update Local new-session and issue-resolution tests to wait for authoritative enablement rather
  than treating the stable button label as a readiness signal.

## Validation

- Focused Local/Remote creation and Remote handoff coverage: 6 files / 53 tests passed.
- `pnpm typecheck`
- `pnpm test`: 994 files passed and 2 skipped; 6,241 tests passed and 3 skipped.
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

No exception is required. `src/renderer/components/new-session/NewSessionForm.tsx` remains at 347
lines after the stable action presentation was added.

## Notes

This follow-up changes renderer presentation only. The running installed application still needs a
new package/restart before live acceptance.

## Related review

- `ref/reviews/recent-3-days/REVIEW_258_session-create-button-stability.md`
