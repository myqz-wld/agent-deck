---
review_id: 313
reviewed_at: 2026-10-02
baseline_commit: 17b48bbab7f855140f96c58e3a26c275c18b1bfe
expired: false
---

# Grok queued mid-turn interjections

## Scope

Focused debugging of ordinary Grok messages that entered the local queue while an earlier prompt
or interjection awaited provider acceptance. This is a local engineering audit, not an independent
paired review. The review-expiry script was run; unrelated coverage receives no exemption.

```review-scope
src/main/adapters/grok-build/__tests__/turn-queue-interjection.test.ts
src/main/adapters/grok-build/pending-outgoing.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/turn-boundary.ts
src/main/adapters/grok-build/turn-queue.ts
```

## Findings and fixes landed

1. Ordinary input used `_x.ai/interject` only when no submission was pending at send time. Later
   messages lost that intent when queued. After acknowledgement, `drain` still rejected every
   active turn, leaving subsequent input waiting for the full prompt result. Ordinary input now
   retains its interjection eligibility. Prompt acknowledgements and interjection completion
   resume eligible queue heads during the same active turn.
2. Incoming messages could bypass older queued input. Direct interjection now requires an empty
   local queue. Internal `enqueue` messages retain their next-turn semantics and FIFO position;
   they are never promoted into interjections. Removing a queue head wakes eligible following
   input, and unsupported-extension fallback restores the already admitted message at the front
   without rejecting it because later messages filled the queue.
3. Queue promotion must preserve cancellation, runtime fences, and exactly-once user events.
   Single-message cancellation releases the next eligible input, while whole-turn interruption
   does not start another interjection. Shared interjection checks cover cwd changes, runtime
   mutation, sandbox replacement, readiness, suppressed updates, closure, and retirement. These
   checks run again after asynchronous input materialization. Already emitted or persisted user
   messages are not emitted again when later promoted or requeued.

## Validation and evidence

- Before the fix, both new delivery regressions failed: the second interjection never issued
  after the first receipt, and input queued before the first prompt receipt never interjected.
- All 25 new regressions passed after the fix. Coverage includes consecutive and early sends,
  FIFO preservation, single-message cancellation and late receipts, whole-turn interruption,
  unsupported-extension fallback, ambiguous transport failure, user-event deduplication, and
  runtime fences before and after asynchronous preparation.
- `pnpm typecheck` passed, including architecture boundaries and both TypeScript projects.
- `pnpm build` passed for main, preload, and renderer outputs.
- `pnpm test` passed: 1,131 files / 7,026 tests, with 3 files / 6 existing conditional skips.
  This run includes the preceding Claude streaming-input fix and the existing Grok ACP,
  cancellation, recovery, and cwd-transition tests.
- `git diff --check` passed. The changed queue is 475 lines; all changed source and test files
  remain below the repository's 500-line guardrail.

## Residual risk and follow-ups

The provider continues to choose the safe point at which accepted interjections enter model
context. A pending provider receipt can still delay later submissions. Binaries without the
interjection extension intentionally fall back to next-turn FIFO. Ambiguous transport failures
are surfaced without automatically replaying a possibly accepted message.

Tests use deterministic ACP responses rather than a paid live model conversation. Per the user's
existing preference, no installed application, Worker, or live session was replaced or restarted.
The main-process change requires installation of a new build and a restart to become active in
the installed application. No further in-scope source repair is pending.
