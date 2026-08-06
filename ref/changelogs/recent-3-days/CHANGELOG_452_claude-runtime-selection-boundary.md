---
changelog_id: 452
changed_at: 2026-08-05
---

# CHANGELOG_452_claude-runtime-selection-boundary: Extract Claude runtime selection

## Summary

Claude sandbox and model precedence now run in one pure runtime-selection policy. The desktop
facades retain resumed-session lookup and the lazy global sandbox settings read while provider
profiles and explicit session inputs remain caller-owned.

## Selection boundary

- Added pure sandbox selection over explicit, persisted, lazy-global, and safe `off` fallback
  inputs.
- Preserved lazy settings access: an explicit or resumed sandbox never reads the global setting or
  exposes a new settings failure path.
- Added pure model selection over explicit, resumed, provider-profile, and SDK-default inputs.
- Preserved resumed-session lookup timing in the facades, including existing create-session cleanup
  when persistence or settings reads fail.

## Node boundary gate

- Added Claude runtime selection as the eighteenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Node builtins, Electron, runtime-host, session, store, and
  utility singleton dependencies in the policy.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eighteen Node 22 bundle
  candidates.
- Focused selection/facade/cleanup coverage: passed, 3 files / 14 tests; the new policy accounts for
  1 file / 6 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 621 files / 4,782 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 104 structured changelogs, maximum id 452.

## Do Not Split Protection

Keep sandbox/model selection, both desktop facades, lazy-default and failure-cleanup tests, and the
executable boundary gate together. Precedence and read timing are one session-start contract.

## Remaining boundary

Additional provider settings/process ownership, Browser, and checkpoint worker transforms remain
extraction blockers. No shared development process was started, restarted, or stopped.
