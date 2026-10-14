---
plan_id: 90
completed_at: 2026-10-14
status: completed
---

# Runtime confirmation parity

## Goal

Complete the user's IAB feedback after the unified permission modes in commit `e979fc7c`.

## Constraints and decisions

- Use `权限` in session details and `完全开放` for the unrestricted sandbox choice.
- Confirm no-prompt and fully open transitions consistently across all three providers and both
  Local and Remote views; preserve each provider's actual application timing.
- Reuse the existing warning SVG and explain permission versus sandbox effects through their UI labels.
- Preserve Remote Workspace limits and abandon confirmations when the original context disappears.
- Use real renderer components with synthetic APIs for IAB demonstration; preserve live sessions,
  Agent Deck processes, installed bundles, and concurrent repository work.
- Keep the scrolling correction in the local preview. Browser skill changes were explicitly excluded
  after the user learned that the problem came from preview CSS.

## Completed tasks

1. Added a shared confirmation hook, concise copy, consistent labels, and warning icons.
2. Integrated Local and Remote controls, same-value guards, and cancelled custom-profile restoration.
3. Made Core Claude bypass changes use the native cold restart path and replacement identity.
4. Added cross-provider interaction and Core transition regression coverage.
5. Verified the UI in IAB, corrected the preview's document scrolling, and retained the preview tab.
6. Updated README behavior documentation and archived the final evidence.

## Validation

Targeted suite: 113 passed. Full suite: 7,254 passed and 6 skipped across 1,159 files.
Typecheck, architecture checks, and build passed. All changed source files remain below 500 lines.
IAB verifies renderer interaction only; provider effects are covered by automated tests, not live execution.

## Final status and handoff

Implementation and validation are complete. The user authorized committing these changes and viewing
the IAB demonstration. The ignored preview is intentionally retained; no installed runtime activation
is included. Final evidence: `ref/changelogs/recent-3-days/CHANGELOG_679_runtime-confirmation-parity.md`.
