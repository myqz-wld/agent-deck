---
changelog_id: 550
changed_at: 2026-08-05
---

# CHANGELOG_550_claude-recovery-node-boundary: Bundle complete Claude recovery paths

## Summary

The complete Claude disconnect-recovery orchestrator and its shared JSONL fallback helper now pass
the executable Node 22 boundary gate. Their injected session, filesystem, continuation, diagnostic,
and SDK ownership is sufficient without Electron or desktop utility composition.

## Executable recovery boundary

- Added `claude-jsonl-fallback-core` for the shared transcript-missing/cwd-fallback helper.
- Added `claude-recovery-core` for the complete `recoverAndSendImpl` orchestration path.
- Both candidates bundle transitively for Node 22 with no external package exemption.
- Raised the executable boundary inventory from 90 to 92 candidates.
- Strengthened the JSONL fallback architecture rule to reject session-defaults, SessionManager,
  store, and all desktop utility imports rather than guarding only the legacy logger.

## Preserved recovery behavior

- Transcript capture and freshness checks remain host-owned and best effort where documented.
- JSONL absence, cwd fallback, archive restoration, single-flight recovery, close-epoch
  cancellation, application/CLI identity, user publication, and cleanup authority are unchanged.
- Recovery and fallback warnings remain non-authoritative: a throwing observer cannot alter the
  recovery result or suppress cleanup.
- No new fallback, queue, process, session, persistence, or renderer behavior was introduced.

## Direct evidence

- The production Vite boundary checker bundles both complete entry points, not reduced test
  facades or hand-selected dependency fragments.
- Existing JSONL fallback tests retain resume/fallback, continuation, publication ordering,
  attachment, and freshness coverage.
- Existing recovery tests retain disconnect, fallback, lifecycle restoration, cancellation,
  deduplication, rename, and cleanup coverage.
- Diagnostic-host regressions still prove observer exceptions cannot replace recovery authority.

## Validation

- Focused recovery coverage: passed, 4 files / 52 tests.
- Claude plus Core coverage: passed, 129 files / 511 tests.
- Node and web TypeScript plus architecture gates passed with 92 Node candidates.
- `mise exec -- pnpm build`: passed; main production bundle transformed 790 modules.
- Canonical Electron full suite completed successfully twice in this slice.
- `recover-and-send-impl.ts` is 498 lines and `jsonl-fallback.ts` is 499 lines.
- `git diff --check` passed and the cached Git index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep both executable candidates and the strengthened fallback import rule together. Testing only
the leaf helpers would allow a future desktop facade or persistence dependency to re-enter one of
the complete recovery paths while the smaller Core gates stayed green.

## Remaining boundary

The known Claude create and recovery orchestrators are now executable Node candidates. The next
bounded slice should inventory the nearest remaining provider settings, repository, or composition
entry point that is still Electron-owned, add one complete executable boundary, and repair only the
concrete dependency leak exposed by that gate.
