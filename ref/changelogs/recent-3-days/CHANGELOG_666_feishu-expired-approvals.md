---
changelog_id: 666
changed_at: 2026-09-30
---

# Clear Feishu expired approval guidance

## Summary

An expired approval card now explains that the presentation has expired and directs the owner to
current pending items or a fresh request when the original has ended. Invalid signatures retain
distinct guidance. A Core-confirmed expired/cancelled request has an accurate terminal card.

## Changes

- Preserve presentation-expiry classification through the official SDK callback boundary.
- Validate malformed action/form data before assigning an expiry reason.
- Keep rejected old actions from invoking Core or replaying work; preserve signed approval checks.
- Remove action buttons only through the existing trusted terminal-card response when Core state
  confirms that the request has ended.

## Validation

51 focused and 6,918 full-suite tests pass, with six existing skips. Type/architecture,
headless/native builds and headless/deployment checks pass. Runtime activation passed in
[PLAN_78](../../plans/recent-week/PLAN_78_feishu-operations-approval-activation.md); the old-card
visual check remains optional owner feedback. See [REVIEW_308](../../reviews/recent-week/REVIEW_308_feishu-expired-approvals.md).

## Do Not Split Protection

None. Changed source files are below 500 lines. README, prompt assets and native runtime controls
are unchanged; the owner chose existing native tools for Workspace file/folder deletion.
