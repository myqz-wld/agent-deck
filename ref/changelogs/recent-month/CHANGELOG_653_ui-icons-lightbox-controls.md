---
changelog_id: 653
changed_at: 2026-09-29
---

# UI Icons and Image Preview Controls

## Summary

Finish the Live-tab icon updates omitted from the previous session-detail change, replace other
built-in UI emoji decorations with semantic SVGs, and make image-preview controls fade while idle.

## Changes

- Live cards share the detail view's SVG tool icons and argument summaries. Browser and Shell
  remain distinct, Grok aliases retain paths/queries, and generic `other` does not mask known tools.
- Separate activity text from icon selection. Local and Remote status rows, timeline fallbacks,
  permission/question/plan/diff rows, summary triggers, errors, toasts, and handoff/settings hints
  use the source-owned icon system. Remove the unused emoji tool-map module.
- Share turn-outcome formatting so a failed or interrupted Live round no longer appears successful.
  Keep waiting priority, three-line activity bounds, deduplication, and provider-specific controls.
- Keep sandbox/permission labels as text and carry warning metadata into DeckSelect. Its trigger
  and options draw SVG warnings without changing option values, descriptions, or approval actions.
- Add hover, pressed, keyboard-focus, and saving feedback to image-save buttons. Center the preview
  action bar at the bottom; fade it and the close button after 1.8 seconds of pointer inactivity.
  Movement reveals them. Hovering actions, keyboard navigation, and an in-progress save keep them
  visible. Escape and focus trapping/restoration remain available while controls are hidden.
- Document the presentation in README. User/model message bodies, stored provider messages, and
  protocol markers remain intact. No dependency, IPC, provider, database, or host lifecycle change.

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

## Do Not Split Protection

None. Changed source/test files are at most 500 lines. Live activity presentation and auto-hide
state have focused helpers. The oversized composer suite was split without removing test cases.

## Related records

- [Implementation review](../../reviews/recent-month/REVIEW_285_ui-icons-lightbox-controls.md)
- [Completed plan](../../plans/recent-month/PLAN_61_ui-icons-lightbox-controls.md)
- [Previous content and image delivery](CHANGELOG_652_session-content-generated-images.md)
