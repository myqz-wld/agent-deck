---
plan_id: PLAN_31
title: Handoff lifecycle and continuation-context v2 hardening
status: completed_with_residuals
created_at: 2026-08-07
updated_at: 2026-08-08
completed_at: 2026-08-08
base_branch: main
base_commit: 30fd1c98eaeed829af82dddef5f295489ce42871
review_invocation: hnd-0807-30fd
related_changelog: CHANGELOG_436
related_review: REVIEW_216
---

# Goal and invariants

- Fix the two reproduced failures: a completed predecessor mislabeled as an active handoff, and
  large UI preparations rejected because a 32 MiB-capable TEMP spool is charged to an 8 MiB
  resident cache.
- Keep exactly one logical owner per handoff epoch. A committed durable alias blocks predecessor
  reacquisition until explicit reactivation deletes that alias.
- Preserve accepted source input exactly once across commit, rollback, rename, close, and
  reactivation races.
- Keep provider continuation input bounded, versioned, provider-neutral, and separated from the
  authoritative instruction persisted in Agent Deck history.
- Treat a started successor as at-least-once execution: failures must disclose possible partial
  execution and duplicate effects on retry. A suspended/precommit provider runtime is excluded.

# Confirmed decisions

- Publish private provider Continuation Context v2. Keep the canonical checkpoint schema at v1 and
  keep legacy v1 wrapper detection for historical filtering.
- Build a lean provider projection and use it for rendering and token/byte selection. Do not expose
  internal session ids, revisions, hashes, evidence ids, timestamps, priorities, default fields, or
  absolute attachment paths to the provider.
- Split UI preparation admission into an 8 MiB resident-payload pool and a 32 MiB cached-spool pool.
  Keep spool cleanup ownership on the cache entry. Do not add a global UI+MCP in-flight reservation
  manager in this delivery.
- Await native trusted-turn acceptance for observed capacity too. Preserve lower-budget retry for
  unknown/stale capacity, but an optional retry that cannot fit the instruction must not discard a
  valid primary candidate.
- Do not implement a cross-adapter suspended successor. Add explicit at-least-once failure copy,
  abort/close ordering, bounded late cleanup, durable-alias acquisition guards, and finalization
  sealing.
- Preserve the current linearization rule where a send that already observed an old-epoch redirect
  completes against that successor even if explicit reactivation wins during its awaited unarchive.
- Prefer source availability after rollback replay settlement timeout. The coordinator may open a
  new owner epoch while an uncancellable old replay is still settling; disclose this as
  at-least-once behavior instead of holding the source gate indefinitely.

# Scope and exclusions

## In scope

- `src/main/session/continuation-context/**` rendering, budgets, cache, capture TTL, fold/runtime
  deadlines, materialization progress, warnings, and tests.
- `src/main/session/hand-off/**` acquisition, rollback replay, readiness, execution/finalization,
  error copy, and tests.
- Claude/Grok trusted-turn and rollback persistence parity.
- MCP/UI handoff diagnostics and durable alias integration.
- Runtime/UI copy, changelog, plan, review, and indexes. Bundled prompt assets remain unchanged in
  this delivery because their protocol remains correct and durable prompt edits require a separate
  exact-scope approval.

## Excluded / accepted residuals

- A new provider API that creates a successor without running its first turn.
- Application-wide spool reservation spanning cached UI previews, in-flight UI preparation, and MCP.
- Adapter-authoritative tokenizer integration where no tokenizer contract exists.
- Reinterpreting an already-started old-epoch send to belong to a newly reactivated epoch.
- A cross-adapter abort/epoch-acceptance contract for rollback replay.
- Durable provisional-successor cleanup ownership and restart reconciliation.

# Checklist

- [x] Read repository instructions, current plans/reviews/changelogs, and handoff implementation.
- [x] Complete Round 1 with five Claude+Codex paired batches and one integration batch.
- [x] Complete mandatory rebuttals for every HIGH finding.
- [x] Obtain user approval for Context v2, dual cache pools, and explicit at-least-once semantics.
- [x] Implement provider projection v2, aligned estimators, shrink rerender, and terminal errors.
- [x] Make lower-budget retry optional and fix Claude pending snapshot persistence.
- [x] Split cache resource pools and enforce spool TTL/cleanup.
- [x] Repair background materialization, fallback deadlines, coverage copy, and fold diagnostics.
- [x] Add discriminated acquisition including durable aliases and actionable predecessor copy.
- [x] Repair rollback rename/hang behavior and Grok duplicate history.
- [x] Await observed acceptance, seal finalization failures, and improve candidate/failure cleanup copy.
- [x] Run focused tests after each subsystem, then typecheck, full test, build, and diff checks.
- [x] Complete Round 2 and Round 3 for every changed primary batch.
- [x] Complete focused Round 4 for CTX-CAPTURE and adjudicate the LIFE-COMMIT HIGH finding.
- [x] Complete focused Round 5 for LIFE-GATE/LIFE-COMMIT.
- [x] Complete the final paired integration pass and focused raw-tail remediation review.
- [x] Archive PLAN_31, CHANGELOG_436, REVIEW_216, and their bucket indexes.

# Completion

The implementation and all paired Claude/Codex review rounds converged. The two original user
failures are closed, Continuation Context v2 is provider-private and persistence-safe, lifecycle
acquisition is durable across restart, and rollback behavior follows the user-approved
availability-first boundary. Full Electron tests, typecheck, production build, whitespace checks,
and the changed-source 500-line guard passed before archival.

# Risks and validation requirements

- Changing the private wrapper version can accidentally reintroduce recursive capsules unless the
  classifier recognizes both v1 and v2 prefixes.
- Cache accounting must keep resident bytes and logical spool bytes separate while preserving LRU,
  pinned-entry rejection, and exactly-once `onDiscard` cleanup.
- Replay timeout copy must state that an uncancellable old replay can still settle after a new epoch
  opens; this accepted at-least-once risk must not be presented as guaranteed replay failure.
- Awaiting observed acceptance changes latency and must retain the shared monotonic deadline and
  accurate cleanup state.
- Every accepted race requires a deterministic unit test; SQLite ownership and alias sequences need
  Electron-backed tests.
