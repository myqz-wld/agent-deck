---
plan_id: 61
completed_at: 2026-09-29
status: completed
---

# Built-in UI Activity Icons

## Goal and authorization

The user identified the Live session-list icons missed by the previous session-detail delivery,
then explicitly asked to find and address other remaining emoji uses. Apply the existing SVG
icon system to built-in UI decorations across Local/Remote cards, events, pending rows, and dialogs.

## Invariants

- Preserve user/model-authored content and provider/protocol markers; do not rewrite arbitrary
  message text or historical data just to remove emoji.
- Reuse shared semantic tool icons, keep Browser/Shell distinctions and specific Grok aliases.
- Preserve Claude permissions/questions/plan approvals, event pairing, and source authority.
- Keep text labels alongside icons, keyboard behavior, truncation, and native select semantics.
- No new dependencies, host restart/install, delegation, or prompt-asset edits are planned.

## Progress

1. Completed inventory: 222 matches in 69 non-test source files; many are comments or provider
   recovery protocol text. Classify actual UI decorations before editing.
2. Completed: Live cards now use structured summaries and shared SVG tool icons; compact tool
   summaries reuse the detail formatter. Remote status rows share the same presentation.
3. Completed: remaining pending/dialog/status decorations and plain-text event icon paths.
4. Completed first validation: 6,522 tests, typecheck/build, and synthetic Browser checks.
5. Added by user: save-button hover/pressed/focus feedback and auto-hiding lightbox controls.
   Implemented: bottom-centered actions, 1.8s idle fade, hover/keyboard/save hold, and button
   feedback. Fourteen focused image regressions passed; final full suite is 6,525 passing tests.
6. Completed: final typecheck, full suite/build, Browser verification, and final records.

## Decisions and boundaries

Dropdown labels stay text; DeckSelect renders warning icons from explicit metadata. System/provider message prefixes
must retain their runtime meaning; any display-only treatment must leave source text intact.
The prior commit/push request applied to the completed delivery; this follow-up is source work.

## Final handoff

Completed the confirmed source changes, including the later lightbox request. No unresolved
product question remains. Renderer-only changes need no main-process restart; the installed
application has not been replaced. The prior implementation commit remains separate.

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

See [CHANGELOG_653](../../changelogs/recent-week/CHANGELOG_653_ui-icons-lightbox-controls.md)
and [REVIEW_285](../../reviews/recent-month/REVIEW_285_ui-icons-lightbox-controls.md).
