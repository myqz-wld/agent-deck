---
changelog_id: 367
changed_at: 2026-07-14
---

# CHANGELOG_367_summary-refresh-thresholds: Reduce background summary frequency

## Summary

Fresh installations now default intermittent summaries to every 30 events instead of every 10.
Continuation-checkpoint normal refreshes now require at least 32,000 newly uncheckpointed normalized
tokens; the existing 48,000-token safety refresh remains unchanged.

## Defaults and scheduling

- Changes `summaryEventCount` in the shared application defaults from 10 to 30 without overriding
  an existing user's persisted setting.
- Raises the normal checkpoint refresh floor from 8,000 to 32,000 tokens, so 31,999 tokens remains
  ineligible even after the interval and quiet-window gates have elapsed.
- Keeps the 48,000-token safety path, provider-idle requirement, 60-second quiet window, and
  configured refresh interval semantics unchanged.

## User-facing documentation

- Updates the Simplified-Chinese settings explanation to show the 32,000-token normal floor.
- Documents the 30-event summary default and the 32,000 / 48,000 checkpoint thresholds in README.

## Validation

- Added boundary assertions for the 30-event UI default and 31,999 / 32,000 checkpoint behavior.
- Ran targeted summary, continuation settings, checkpoint scheduler, and checkpoint service tests.
- Ran `pnpm typecheck`, `pnpm test`, and `git diff --check`.

## Do Not Split Protection

No new large source file or coupled subsystem was introduced; the policy, UI copy, documentation,
and boundary tests remain in their existing focused modules.
