---
changelog_id: 661
changed_at: 2026-09-30
---

# Feishu adapter-native settings and approval cards

## Summary

Assistant chats and new work sessions independently remember their adapter's mode and sandbox,
along with model settings. Native approval cards show readable actions and retain their terminal
state after a click.

## Changes

- Share adapter-specific settings between Feishu and connected Desktop settings. Validate choices
  against live Core capabilities and preserve omitted values in same-adapter edits. A different
  adapter resets incompatible choices; null runtime values follow its creation defaults.
- Keep `/chat runtime-set` scoped to the current assistant and `/runtime-set` to selected work.
  `/settings chat|session` edits future defaults without changing existing sessions. Provider sandbox
  replacements update the affected target and retain its subscription intent.
- Return approval result cards in the Feishu callback instead of PATCHing before acknowledgement.
  Show canonical parameters, target labels, Chinese status and approve/deny buttons. Ended
  cards cannot execute again; incomplete previews require the full client.
- Restrict pending notifications to their owning session. Missing unrelated work subscriptions no
  longer block the assistant's reply, and cleared pending requests produce no empty approval alert.
- Advance the exact public protocol to 2.11; retain existing preference files and SQLite schema v5.

## Validation

6,815 tests passed with three existing skips. Typecheck/architecture, application build, Linux
reproducibility, native archives, headless/deployment gates and actual artifact privacy checks passed.
The coordinated release is installed and independently verified; the authorized assistant policy
is saved at preference revision 3. See REVIEW_302 and PLAN_70 for activation evidence and the
remaining owner checks of the new card presentation and terminal state.

## Do Not Split Protection

None. Changed source files remain within 500 lines.
