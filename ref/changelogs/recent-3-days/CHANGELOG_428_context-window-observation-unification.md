---
changelog_id: 428
changed_at: 2026-08-03
---

# CHANGELOG_428_context-window-observation-unification: Unify observed context capacity across continuations

## Summary

Agent Deck now learns effective context-window capacity from trusted Claude, Codex, and Grok
runtime evidence, stores that evidence under an exact provider-neutral runtime identity, and uses
the same frozen resolution policy for handoff, recovery, and checkpoint generation. Unknown or
stale targets remain explicit and conservative instead of inheriting a static model catalog.

## Observation and persistence

- Added exact runtime identities covering adapter, provider or Gateway, concrete model, and
  capacity-affecting configuration, with bounded serialized keys and fail-closed handling for
  aliases, ambiguity, malformed values, and unattributed events.
- Added the current-only schema-v62 `context_window_observations` store with seven-day freshness,
  deterministic source priority and equal-time conflict handling, restart reuse, and session-row
  deletion independence.
- Unified session occupancy and durable capacity ingestion so an identity change clears stale
  occupancy while safe usage values can remain visible without manufacturing a capacity row.
- Attributed Claude capacity only to one exact primary or authoritative Gateway match, Codex
  capacity to the effective thread identity, and Grok capacity to the negotiated native runtime.

## Continuation sizing and lifecycle

- Replaced the process-local minimum/static fallback with frozen `observed`, `stale`, and `unknown`
  resolution shared by handoff, recovery, foreground checkpoints, and background checkpoints.
- Observed targets use the reported effective window. Stale or unknown handoffs prepare one 64k
  policy candidate and one same-snapshot 32k candidate; recovery renders only its 64k primary, and
  generator folds use the conservative unknown policy without resizing themselves from evidence
  learned during that fold.
- Added a trusted continuation gate with one monotonic total deadline, native first-model-activity
  acceptance, proven rollback before one lower-budget retry, exact late-candidate cleanup, and no
  source ownership transfer until acceptance and mandatory resource transfer succeed.
- Hardened deadline and startup races, including wall-clock rollback, work/timer microtask ordering,
  synchronous and asynchronous startup rejection, entry-expired settled work, and cleanup-state
  attribution.

## Adapter and public-boundary hardening

- Prevented ambiguous shared-client Codex reroutes from contaminating another turn: concurrent
  subscribers invalidate exact identity, stale settings completion cannot resurrect it, and
  pre-invalidation capacity evidence cannot survive into checkpoint output.
- Removed failed new Grok strict-startup registrations after provider disposal, with a closed-row
  fallback when deletion is guarded.
- Projected primary and retry startup failures through fixed safe IPC/MCP/UI copy while keeping raw
  provider diagnostics in main-process logs.
- Kept context-window identity, observation source, capacity, prompts, spool ids, and acceptance
  evidence out of public inputs; renderer diagnostics remain additive and bounded.

## Compatibility and design boundaries

- Advanced the current schema baseline to v62. Older databases continue to be rejected unchanged;
  no migration or compatibility rewrite was introduced.
- Added no manual capacity override, marketing model catalog, transcript-derived estimate, paid
  capacity probe, or new LLM call.

## Validation

- Full Electron-ABI suite: 462 files / 3,814 tests passed; one opt-in live-provider smoke skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, review-expiry inventory, legacy-consumer
  search, production file-size checks, and `git diff --check` passed.
- Final focused Codex identity/evidence suites: 4 files / 45 tests passed. The two heterogeneous
  Integration reviewers independently closed the last stable finding with no new findings.
- A production-build Electron restart smoke used an isolated profile and port: schema v62
  initialized, MCP mounted, 127.0.0.1:47822 listened, `/mcp` returned the expected unauthenticated
  401, and shutdown drained cleanly without disturbing the active host on 47821.

## Do Not Split Protection

Runtime identity, observation persistence, frozen budget selection, trusted acceptance, rollback,
cleanup, and public projection form one safety chain. Do not land or revert only one layer without
revalidating the complete provider-event-to-handoff-result trace.

## Related records

- `REVIEW_210_context-window-observation-unification.md`
- `PLAN_30_context-window-observation-unification.md`
