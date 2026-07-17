---
changelog_id: 378
changed_at: 2026-07-16
---

# CHANGELOG_378_plan-review-chat-feedback: Clarify deep-review response progress

## Summary

The plan deep-review dialog now aligns the right edge of its decision actions
with the feedback textarea and gives immediate, conversational feedback while a
question is being answered.

## Changes

### Decision tray alignment

- Made the feedback textarea use the full width of the decision tray.
- Moved the continue and approve actions to the following row so the approve
  button's right edge aligns with the textarea's right edge.
- Kept generated-feedback status and error text associated with the textarea
  through the existing accessible description.

### Question response feedback

- Clear the question and attached plan quotes immediately after a valid submit.
- Keep the question composer and send action disabled while the correlated
  review turn is in progress.
- Render an accessible animated reply bubble on the assistant's left side until
  the review turn completes, then leave the empty send action disabled.
- Extracted conversation rendering into a focused component to keep the dialog
  below the repository's source-file size guardrail.

## Validation

- `pnpm typecheck`
- `pnpm test`: 319 files passed, 1 skipped; 2,900 tests passed, 1 skipped.
- Targeted plan-review dialog tests: 16 tests passed.
- `git diff --check`
- Browser-level verification was unavailable because the in-app browser client
  could not initialize in the current control runtime.

## Do Not Split Protection

None. The conversation renderer was extracted and all changed first-party source
files remain below 500 lines.

## Notes

This change is renderer-only and requires no application restart when the
development server is already running; HMR can apply it directly.
