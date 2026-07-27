---
changelog_id: 396
changed_at: 2026-07-26
---

# CHANGELOG_396_resumable-plan-deep-review: Resume background plan review

## Summary

Plan Deep Review can now be closed while a question or feedback draft is waiting on AI work.
The isolated review continues in the background, and reopening the pending plan restores its
conversation binding, progress indicator, attached context, and unsubmitted drafts.

## Changes

### Background review lifecycle

- Allow the close button and Escape to dismiss Deep Review during question and feedback generation;
  only an in-flight final plan decision keeps the dialog locked.
- Keep question, child-session identity, reply progress, quotes, manual feedback, generated feedback,
  and errors in a request-keyed renderer store instead of one dialog mount.
- Preserve that state when the pending row or its containing session view unmounts, so switching
  tabs or sessions does not restart or duplicate the review turn.
- Ignore late async completions after a plan has resolved, preventing cleared draft state from being
  recreated by an aborted review operation.

### Return status and cleanup

- Change the pending-card action to `审阅进行中…` while AI work continues and `返回审阅` after a
  review draft exists.
- Explain in the dialog and close-button tooltip that background work continues after dismissal.
- Clear renderer review state after approval, revision, cancellation, or another successful plan
  response.

### Documentation

- Update the README human-review summary with background-and-return behavior.
- Keep the paired Claude/Codex `present_plan` protocol and isolated-review prompt unchanged because
  this feature changes renderer lifecycle only.

## Validation

- `pnpm typecheck` passed.
- Focused plan-review and renderer-store coverage passed 3 files and 22 tests.
- `pnpm build` passed.
- `pnpm test` passed 364 files and 3,092 tests, with one credentialed smoke skipped. Two unrelated
  environment-sensitive tests failed: the Grok asset test discovered real Claude plugins outside
  its temporary `GROK_HOME`, and the bundled Grok binary test could not find the installed
  `@xai-official/grok-darwin-arm64` platform package.
- `git diff --check` passed.

## Do Not Split Protection

None. The request-keyed review state is isolated in a focused store, and every changed production
source file remains below 500 lines.

## Notes

This change is renderer-only and can be applied through HMR when the development server is running.
