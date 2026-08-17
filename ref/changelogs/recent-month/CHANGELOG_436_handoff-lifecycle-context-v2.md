---
changelog_id: 436
changed_at: 2026-08-08
---

# CHANGELOG_436_handoff-lifecycle-context-v2: Harden handoff context and ownership

## Summary

Session handoff now keeps provider context private and bounded, admits legal large captures, reports
predecessor ownership accurately, and preserves an availability-first rollback boundary without
hiding possible duplicate effects.

## Continuation Context v2

- Render one lean provider projection for both estimation and injection. Internal session ids,
  revisions, hashes, evidence, timestamps, priorities, absolute attachment paths, and durable
  coverage-marker details no longer reach the successor provider.
- Keep the authoritative user instruction separate and last. Claude, Codex, and Grok receive the
  private provider prompt while snapshots, events, and replay-visible history persist only the
  public instruction text.
- Re-render after every history reduction, preserve byte-limit versus token-limit diagnostics, and
  keep a viable primary handoff when the optional lower-budget retry cannot fit.
- Continue filtering both v1 and v2 continuation wrappers so generated context cannot recursively
  enter a later handoff.

## Capture, budgets, and checkpoints

- Split UI preparation admission into an 8 MiB resident-payload pool and a separate 32 MiB
  aggregate logical-spool pool with LRU, pin, expiry, and discard accounting.
- Enforce spool TTL on every read and use exact UTF-8 accounting. Foreground and background capture
  now exclude non-semantic telemetry before source and raw-user-tail resource accounting.
- Turn an oversized leading checkpoint revision into a bounded integrity marker, combine persistent
  and newly uncovered revision ranges, keep provider deadlines strictly positive, and record
  deterministic non-CAS fold failures.
- Share one absolute Claude structured/fallback generation deadline so fallback cannot silently
  extend a timed-out checkpoint call.

## Handoff ownership and readiness

- Distinguish active work, sealed predecessors, committed durable successors, and ownership-store
  lookup failures. UI and MCP now name an already committed successor instead of telling the user
  to wait forever.
- Seal predecessors after post-transfer finalization failure, consult durable aliases after restart,
  and delete every touching alias edge transactionally when a session is deleted or history-purged.
- Shift rollback inputs before replay, prevent rename/backoff duplication, bound settlement, and
  report explicit reactivation detachments exactly once. An already-running uncancellable replay may
  still settle after the new epoch opens, matching the user-approved availability-first policy.
- Await native trusted-turn acceptance for observed capacity too, strictly remove rejected
  candidates before a lower retry, bound late cleanup attempts, and share one language-neutral
  partial-execution classifier between English MCP and Simplified Chinese UI copy.
- Grok rollback replay no longer duplicates persisted user events, including deferred acceptance;
  Claude pending snapshots no longer persist the private provider capsule.

## Validation

- Full Electron suite: 473 files passed, 3,930 tests passed, and one credentialed live smoke remained
  intentionally skipped.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
- Focused final raw-tail validation passed 37/37 tests, including the default UI/MCP capture path.
- Paired Claude/Codex deep review converged across context rendering, capture, lifecycle gates,
  commit/readiness, and final end-to-end integration.

## Do Not Split Protection

No changed production source exceeds 500 lines. `checkpoint-fold.ts` is exactly 500 lines after its
range-union helper moved to the existing coverage-gap module; the other extracted provider payload,
acquisition response, and shared execution-classifier modules keep ownership boundaries explicit.

## Notes

- Related plan: `PLAN_31_handoff-lifecycle-context-v2.md`.
- Related review: `REVIEW_216_handoff-lifecycle-context-v2.md`.
- README was not changed because this delivery repairs existing handoff behavior and internal
  continuation contracts without changing setup or user workflow.
