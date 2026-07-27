---
changelog_id: 382
changed_at: 2026-07-23
---

# CHANGELOG_382_plan-review-feedback-discard-confirmation: Confirm feedback discard

## Summary

Approving a plan from the deep-review dialog now asks for confirmation when the
feedback field contains a non-empty draft, preventing generated or manual
feedback from being discarded by an accidental approval.

## Changes

### Plan approval guard

- Check the trimmed feedback field before starting the approval operation.
- Warn that approval will discard the unsubmitted feedback and require explicit
  confirmation before continuing.
- Leave the dialog open and preserve the complete draft when confirmation is
  canceled.

### Recovery coverage

- Added a renderer test that generates a feedback draft, cancels the discard
  confirmation, verifies the draft remains recoverable, and then confirms that
  an explicit second approval succeeds.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 327 files and 2,934 tests; one opt-in credentialed live
  smoke remained skipped.
- Targeted plan-review dialog tests passed 18 tests.
- `git diff --check` passed.

## Do Not Split Protection

None. Both changed renderer files remain below 500 lines.

## Notes

This change is renderer-only and can be applied through HMR when the development
server is already running.
