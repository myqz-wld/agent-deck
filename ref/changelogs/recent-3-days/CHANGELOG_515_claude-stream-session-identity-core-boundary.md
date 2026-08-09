---
changelog_id: 515
changed_at: 2026-08-05
---

# CHANGELOG_515_claude-stream-session-identity-core-boundary: Fence Claude stream identities

## Summary

Claude SDK first-message identity adoption is now an independently executable, host-neutral Core.
Stable application ids, mutable CLI thread ids, spawn renames, resume forks, phantom runtime ids,
fresh fallbacks, and late-id rejection share one explicit state machine.

## Stream identity Core

- Added `stream-session-identity-core.ts` with exact new-spawn, normal-resume,
  `fresh-cli-reuse-app`, and timeout/close race branches.
- Preserved new-spawn map and persisted-row rename, while normal CLI forks update only the mutable
  `cli_session_id` attached to the stable application session.
- Preserved the phantom-runtime guard when a resumed transcript remains keyed by the application id.
- Preserved fail-closed late first-id behavior after a timeout fallback or closed/replaced spawn;
  rejected ids cannot mutate maps, callbacks, or persistent identities.

## Desktop host and stream processor

- Added `stream-session-identity-host.ts` as the sole owner of `sessionManager` rename/update calls
  and desktop warning diagnostics.
- Replaced the inline first-id/fork block with one Core call, reducing `stream-processor.ts` from
  424 to 311 lines and removing its direct `sessionManager` import.

## Direct evidence and executable gate

- Added direct Core tests for new spawn, real resume fork, phantom runtime id, fresh CLI fallback,
  closed spawn, and late post-timeout identity rejection.
- Retained consume-fork, timeout symmetry, create-failure cleanup, and deferred retirement suites as
  integration/race evidence.
- Added a direct-import rule rejecting stream processor/desktop host and concrete desktop
  session/event/store utilities, plus the eightieth executable Node 22 candidate.

## Validation

- Focused Core/stream race coverage: passed, 5 files / 23 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eighty Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 716 files / 4,991 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, and the changed-file line guard passed.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep stream identity Core, desktop host, processor call site, architecture rule, and direct plus race
tests together. Application and CLI identities must remain distinct: normal forks never rename the
application row, while a late id must never overwrite a fallback or resurrect a closed spawn.

## Remaining boundary

First-id and fork ownership is host neutral. Timeout fallback, stream error/retirement orchestration,
and aggregate provider session composition remain before the full processor can be executable-gated,
alongside real Linux/SSH/Feishu/provider acceptance.
