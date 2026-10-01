---
changelog_id: 664
changed_at: 2026-09-30
---

# Feishu native approval payload depth

## Summary

Feishu can deliver native MCP approval cards containing structured model selections. Previously,
the pending response wrappers consumed the JSON depth budget and rejected valid tool parameters
before any card reached Feishu, leaving the assistant waiting for an invisible approval.

## Changes

- Count pending response/schema wrappers separately from the configured payload depth budget.
- Retain aggregate response bytes, entries, field lengths, request counts and exact schemas.
  Other Core response validators keep their existing depth limits.
- Preserve the complete approval input and signed content binding; changed nested parameters
  still invalidate a previously issued card.

## Validation

Nine focused regressions pass, including native notification delivery, approval callbacks, changed
parameters, depth boundaries and retained resource limits. Full suite: 6,892 passing tests and
three existing skips. Typecheck/architecture, headless build/check and deployment checks pass.
See [local review](../../reviews/recent-3-days/REVIEW_305_feishu-native-approval-depth.md).
[Managed activation](../../plans/recent-3-days/PLAN_73_feishu-native-approval-activation.md) is verified:
the original approval notification was delivered successfully. A fresh owner request subsequently
passed real native approval, natural naming and provider reply in
[PLAN_74](../../plans/recent-3-days/PLAN_74_feishu-relay-live-acceptance.md). Desktop and Worker were
not replaced. The old expired-card toast remains a separate UI follow-up.

## Do Not Split Protection

None. Both changed source/test files remain below 500 lines.
