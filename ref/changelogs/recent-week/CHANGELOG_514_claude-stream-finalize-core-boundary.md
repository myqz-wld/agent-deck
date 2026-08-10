---
changelog_id: 514
changed_at: 2026-08-05
---

# CHANGELOG_514_claude-stream-finalize-core-boundary: Isolate Claude stream retirement

## Summary

Claude SDK stream termination now has an independently executable, host-neutral Core. Pending
provider interactions, usage/live-rate state, session-map ownership, SDK claims, private Gateway
settings, and the stream-drained barrier retire through one bounded lifecycle function.

## Stream finalization Core

- Added `stream-finalize-core.ts` to reject unsettled trusted continuations and permission,
  ask-question, and exit-plan requests with their existing terminal responses.
- Preserved explicit file-change intent and turn-usage cleanup, terminal live-rate publication,
  exactly scoped session-map deletion, and `sdk-stream-ended` event projection.
- Preserved application and distinct CLI claim release without adding close-only recently-deleted
  tombstones, so natural stream completion remains resumable.
- Kept Gateway private-settings cleanup and `streamDrained` settlement in an unconditional final
  barrier, including when a claim release fails.

## Desktop host and stream processor

- Added `stream-finalize-host.ts` as the narrow owner of Agent identity, clock, live-rate desktop
  observation, and `sessionManager.releaseSdkClaim`.
- Replaced the inline terminal block in `stream-processor.ts` with one Core call, reducing the file
  from 500 to 424 lines without changing its first-id, fork, or deferred-retirement behavior.

## Direct evidence and executable gate

- Added direct Core tests for pending resolver outcomes, trusted continuation rejection, usage and
  rate cleanup, exact map/claim isolation, private-settings cleanup, and exceptional barrier release.
- Retained stream retirement, queued input, and translator usage suites as integration evidence.
- Added a direct-import rule rejecting the stream processor/desktop host and concrete desktop
  session/event/store utilities, plus the seventy-ninth executable Node 22 candidate.

## Validation

- Focused Core/stream/translator coverage: passed, 4 files / 29 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-nine Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 715 files / 4,986 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, and the changed-file line guard passed.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep finalization Core, desktop host, stream processor call site, architecture rule, and direct plus
integration tests together. A natural stream end must release distinct SDK identities without
blacklisting resumable sessions, and private cleanup/barrier settlement must survive secondary
claim-release failures.

## Remaining boundary

Stream terminal ownership is host neutral. First-id/fork mapping, timeout fallback, error projection,
and the remaining provider session composition still precede the complete stream-processor boundary,
alongside real Linux/SSH/Feishu/provider acceptance.
