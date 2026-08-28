---
changelog_id: 633
changed_at: 2026-08-27
---

# CHANGELOG_633_codex-clear-stable-id-feedback: Preserve Codex clear completion

## Summary

Codex `/clear` now retains its final system completion or failure message when the original native
thread id is also the stable Agent Deck session id.

## Changes

- Do not add the stable application session id to the retired-native-id fence when Codex replaces a
  same-id native thread during `/clear`.
- Continue rejecting late hook events through the existing SDK ownership claim, without dropping
  subsequent SDK events addressed to the stable session id.
- Add a regression test covering the native-id rotation and final system-message ingest path.

## Validation

- Focused Vitest suite: 3 files / 47 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,016 files passed and 2 skipped; 6,335 tests passed and 3 skipped.
- `pnpm postinstall`
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

No exception is required. The fix changes one identity-fence condition and keeps the regression in
the existing SessionManager public-API suite.

## Related change

- `ref/changelogs/recent-3-days/CHANGELOG_632_session-command-system-feedback.md`
