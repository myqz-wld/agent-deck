---
changelog_id: 516
changed_at: 2026-08-05
---

# CHANGELOG_516_claude-stream-wait-core-boundary: Bound Claude first-message startup

## Summary

Claude SDK first-message waiting and its 30-second fallback are now an independently executable,
host-neutral Core. Provider consumption, interrupt deduplication, stable-id fallback, session-map
switching, and user-visible startup failure share one bounded race coordinator.

## First-message wait Core

- Added `stream-wait-core.ts` with the exact 30-second deadline and a callback-shaped consume port.
- Preserved fire-and-forget provider interruption, the `interruptFired` exactly-once guard, and
  expected-close fencing before any late provider frame can mutate identity.
- Preserved resume-id precedence over the temporary key and exact session-map reassignment, avoiding
  a second recovery child against an orphaned temporary identity.
- Preserved the fixed, user-visible startup failure projection and immediate resolution without
  awaiting a potentially slow provider interrupt.
- Preserved timer cancellation when a first id or natural stream completion wins the race.

## Desktop host and stream processor

- Added `stream-wait-host.ts` as the narrow owner of Agent identity, clock, and desktop diagnostics.
- Replaced the inline timeout orchestration in `stream-processor.ts` with one Core call, reducing the
  processor from 311 to 230 lines.

## Direct evidence and executable gate

- Added direct Core tests for resume fallback/interruption/map reassignment, provider-first timer
  cancellation, and natural stream completion without a first-id callback.
- Retained timeout symmetry, create fail-fast/cleanup, and consume-fork suites as integration/race
  evidence.
- Added a direct-import rule rejecting the stream processor/desktop host/constants and concrete
  desktop state, plus the eighty-first executable Node 22 candidate.

## Validation

- Focused Core/startup race coverage: passed, 5 files / 28 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eighty-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 717 files / 4,994 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, and the changed-file line guard passed.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep wait Core, desktop host, processor call site, identity late-frame fence, architecture rule, and
direct plus race tests together. Timeout must resolve independently of interrupt completion, while a
later provider id must remain unable to overwrite the chosen fallback.

## Remaining boundary

Startup waiting is host neutral. The remaining consume-loop translation/error/retirement composition
can now move behind one aggregate host before real Linux/SSH/Feishu/provider acceptance.
