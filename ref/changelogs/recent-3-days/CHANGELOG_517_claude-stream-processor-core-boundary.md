---
changelog_id: 517
changed_at: 2026-08-05
---

# CHANGELOG_517_claude-stream-processor-core-boundary: Isolate Claude stream composition

## Summary

The complete Claude provider stream processor is now an independently executable, host-neutral
Core. Message dequeue, first-id adoption, SDK translation, deferred retirement, error projection,
and terminal cleanup share one aggregate port while the stable desktop class remains API-compatible.

## Stream processor Core

- Added `stream-processor-core.ts` as the sole owner of the provider async-iteration loop.
- Preserved trusted-continuation observation before translation and stable application-session ids
  for every emitted frame.
- Preserved first-id spawn/fork/phantom/fallback behavior through the extracted identity Core.
- Preserved result-before-retirement ordering, exactly-once queue notification, and asynchronous
  interrupt failure diagnostics without blocking terminal cleanup.
- Preserved expected-close suppression for intentional shutdown while projecting unexpected provider
  failures through an injected agent identity and clock.
- Preserved final resolver, usage, claim, private-settings, and stream-drained cleanup in `finally`.

## Desktop host and stable facade

- Added `stream-processor-host.ts` to aggregate desktop user-message, translation, identity, wait,
  finalizer, clock, and diagnostic ports.
- Exported the existing desktop translation host for composition rather than rebuilding its state
  ownership in the processor.
- Reduced `stream-processor.ts` from 230 lines to a 14-line stable facade with the existing class and
  method surface.

## Direct evidence and executable gate

- Added direct Core coverage for first-id adoption plus content translation and for unexpected query
  failure plus exact final-barrier cleanup.
- Retained retirement ordering, lazy user-message materialization, fork identity, and startup-wait
  suites as facade/integration evidence.
- Added a direct-import rule rejecting all desktop processor/facade hosts, constants, repositories,
  event buses, runtime hosts, and loggers, plus the eighty-second executable Node 22 candidate.

## Validation

- Focused Core/facade/race coverage: passed, 5 files / 17 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eighty-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 718 files / 4,996 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, the direct-import scan, the changed-file line guard,
  and changelog id uniqueness passed.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep processor Core, aggregate desktop host, stable facade, identity/wait/translation/finalizer ports,
architecture rule, and direct plus integration tests together. Result translation must precede
retirement, and every exception path must still enter the final stream barrier.

## Remaining boundary

The Claude provider stream is host neutral. The next slice can inventory the remaining bridge/index
composition and concrete settings/repository ownership before real Linux/SSH/Feishu/provider
acceptance.
