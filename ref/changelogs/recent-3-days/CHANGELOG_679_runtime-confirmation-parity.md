---
changelog_id: 679
changed_at: 2026-10-14
---

# Runtime confirmation parity

## Summary

Align permission and sandbox interactions across Claude, Codex, and Grok in Local and Remote
session details, following the unified permission presets in commit `e979fc7c`.

## Renderer

- Keep the session-detail label as `权限` and use `完全开放` consistently in sandbox selectors.
- Confirm an existing session's transition to `不再询问` or `完全开放` with shared titles and actions.
  Automatic approval and other built-in sandbox choices apply directly; selecting the current value
  does not submit another mutation.
- Explain permission and sandbox effects in separate, plain-language lines. Show native restart or
  next-turn timing separately, and retain the Remote Workspace boundary in descriptions.
- Reuse the existing warning SVG for both the selected no-prompt value and its menu option,
  including preference selectors that map shared options.
- Abort pending confirmations when their session or Remote write authority changes. Cancelling a
  Grok built-in sandbox selection preserves the previous custom profile display.

## Server Core

Route Claude's bypass transition through `restartWithPermissionMode` and return the replacement
session identity. Reject unavailable restart support instead of reporting a hot change that cannot
apply the required native startup flag.

## Validation

- Targeted regression suite: 113 tests passed, including real confirmation dialogs across all six
  provider/surface combinations and Core permission transition effects.
- Full suite: 7,254 tests passed, 6 skipped; 1,156 test files passed, 3 skipped.
- `pnpm typecheck`, architecture boundary checks, and `pnpm build` passed.
- IAB exercised real renderer components with synthetic API responses. Observed both permission
  choices, warning icons, confirmation/cancellation, final copy, and independent sandbox selection.
  These interactions did not start providers or change real sessions.
- The preview's inherited desktop `overflow: hidden` clipped the document. Preview-only CSS restores
  document scrolling; IAB scrolling reached offset 346 with document height 737 and viewport 391.
  The preview remains in ignored workspace material and its tab is intentionally left open.
- Browser skills and the Browser engine were left unchanged at the user's request.

## Do Not Split Protection

No changed source file exceeds 500 lines; no exception is needed.

## Handoff

No running Agent Deck process or installed application was restarted or replaced. Runtime activation
is separate from source validation and the synthetic preview. See
`ref/plans/recent-3-days/PLAN_90_runtime-confirmation-parity.md` for the completed scope.
