---
changelog_id: 376
changed_at: 2026-07-15
---

# CHANGELOG_376_plan-review-quote-and-decision-tray: Refine deep-review decisions

## Summary

The plan Deep Review window now keeps native window controls clear, moves final decisions out of the
title bar, renders selected plan text as quote cards, and treats context-derived revision feedback as
an editable draft that the user must explicitly confirm before it reaches the plan-owning session.

## Review window layout

- Reused the existing 78px frameless-window title inset so the macOS traffic lights no longer overlap
  the Deep Review title.
- Reduced the title bar to the plan identity and close control, balanced the plan and conversation
  panes, and moved approval and revision actions into a persistent bottom decision tray.
- Kept one visible optional revision textarea in the tray. Users can write feedback directly or ask
  the isolated review session to generate a starting draft in the same editable field.
- Added explicit dialog labelling, feedback help/status text, focus restoration, and a footer-based
  focus-trap boundary.

## Quoted plan selections

- Removed the separate “引用所选” and “键盘选择” controls. Selecting plan text now exposes a
  right-click “引用到提问” action; the same existing selection can be attached with the
  platform-specific Cmd/Ctrl+Enter shortcut.
- Displays each selection as a rendered, individually removable quote card above the question input,
  so the textarea contains only the user's question. Multiple quotes retain insertion order and share
  an 8,000-character budget before being serialized as Markdown for the review child.
- Keeps context-menu text snapshots stable after DOM selection loss and closes the menu safely on
  Escape or Tab without closing the review dialog or moving focus behind its overlay.

## Feedback draft lifecycle

- Replaced the auto-submit IPC contract with a generate-only feedback-draft channel across shared
  channels, main registration, preload, and renderer callers.
- Generation no longer resolves the pending plan gate, closes the review child, marks the card as
  handled, or closes the dialog. The user can inspect and edit the result, then explicitly choose
  “继续修改” to submit it through the existing plan response path.
- Preserved serialized child turns and in-flight request coalescing. A generated draft is rejected if
  the plan resolves or moves to a handoff successor before generation finishes, preventing stale text
  from appearing in the old owner UI.
- Generation failures leave any manually entered feedback intact.

## Handoff resolution cleanup

- Plan responses now carry the authoritative owning session id from the service through the main IPC
  and preload boundary. The renderer removes the pending card from that returned owner rather than
  assuming the session that originally submitted the decision still owns the gate.
- Covered the late-decision race where delivery is waiting, a handoff rehomes the card, and delivery
  then succeeds. Both backend pending state and the successor's live renderer bucket are cleared.

## Documentation

- Updated the README Deep Review capability description for rendered right-click/shortcut quotes,
  the bottom decision tray, and the explicit confirmation boundary for LLM feedback drafts.

## Validation

- Focused plan-review validation passed 5 files and 50 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed 319 files and 2,899 tests; one credentialed live smoke remained skipped.
- `pnpm build` passed for main, preload, and renderer bundles.
- `git diff --check` passed before the final record update.
- In-app Browser visual QA could not initialize because the browser runtime reported
  `Cannot redefine property: process`. Component tests cover the title inset, decision placement,
  quote menu, focus behavior, draft confirmation, and service races. The currently running installed
  app was deliberately not closed or restarted, so its main/preload process has not loaded this source
  build.

## Do Not Split Protection

None. Every changed first-party source file remains below 500 lines; the largest changed component,
`PlanDeepReviewDialog.tsx`, is 498 lines after extracting quote and decision-tray presentation.

## Related records

- [CHANGELOG_364](CHANGELOG_364_present-plan-deep-review.md)
- [PLAN_10](../../plans/recent-3-days/PLAN_10_present-plan-deep-review.md)
