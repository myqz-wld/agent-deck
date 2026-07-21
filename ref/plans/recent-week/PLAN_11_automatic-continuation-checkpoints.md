---
plan_id: PLAN_11
title: Automatic bounded continuation checkpoint lifecycle
status: completed
created_at: 2026-07-14
updated_at: 2026-07-14
completed_at: 2026-07-14
base_branch: main
base_commit: b64566618c64018c3343a6ae4f459ca2bf41f6bd
related_changelog: CHANGELOG_365
related_review: REVIEW_160
---

# PLAN_11_automatic-continuation-checkpoints: Keep continuation state fresh without unbounded growth

## Goal and invariants

- Refresh provider-neutral continuation checkpoints automatically at a cadence distinct from the
  periodic session summary.
- Keep complete source events; checkpoints remain bounded derived state and never replace history.
- Never interrupt an active provider turn. Background work may be cancelled or superseded by a
  foreground hand-off/recovery lease, rename, delete, disable, or shutdown.
- Advance coverage only through a complete immutable revision prefix and a validated CAS commit.
- Never evict active, blocked, prior-active resolution, or honest coverage-gap state merely to fit.
- Preserve all existing valid provider/model/Thinking choices while applying the new defaults only
  to new or missing settings.

## Confirmed scope and decisions

- Automatic checkpoint refresh defaults to enabled and 30 minutes. Normal eligibility additionally
  requires at least 8k normalized tokens, 60 seconds quiet, and an idle provider; a 48k safety
  backlog bypasses those scheduling gates without provider interruption.
- Background provider generation is globally serialized at concurrency one. Eligibility estimation
  and source materialization execute in read-only worker threads rather than Electron main.
- Canonical state targets 20k and has a 24k hard cap. Optional facts are evicted whole in a stable
  status / priority / recency / section / id order; required-state overflow stops coverage.
- Continuation defaults are Claude Sonnet / medium, Codex configured model / medium, and Deepseek
  Sonnet / medium. Summary defaults are Claude Haiku / low, Codex configured model / low, and
  Deepseek Sonnet / low.
- Checkpoint enable/interval and summary enable/frequency are exposed independently. Internal 8k and
  48k thresholds remain descriptive settings copy, not user-tunable controls.
- Generator, canonical, target-window, projection, raw-tail, and byte budgets are separately
  documented in Settings and README.

## Completed checklist

- [x] Commit the preceding automatic runtime-control and hand-off coverage repair as baseline
      `b6456661` before expanding checkpoint lifecycle behavior.
- [x] Add revision-driven scheduling, normal/safety eligibility, global generation serialization,
      foreground lease priority, and automatic re-arming.
- [x] Move backlog estimation and latest-at-execution immutable materialization into read-only SQLite
      workers with bounded row, byte, and response DTO sizes.
- [x] Add production worker-safe checkpoint/event readers and verify the emitted dependency closure
      contains no Electron, logger, migration, or process-owned DB facade.
- [x] Rebuild normalized evidence from the exact consumed raw prefix and close abort/late-ready /
      terminate races in worker clients.
- [x] Add deterministic 20k/24k canonical fitting, whole-fact eviction, protected-state semantics,
      and three-generation persisted retention.
- [x] Add checkpoint and summary enable/default settings, compatibility repair, IPC validation, and
      complete Simplified-Chinese lifecycle/budget help.
- [x] Cover startup, restart, dormant/closed state, provider busy/idle, rename, delete, shutdown,
      CAS, partial prefix, large-row responsiveness, tool evidence, and canonical overflow.
- [x] Pass focused tests, typecheck, production build, logger, diff, LOC, worker smoke, and an
      independent `gpt-5.6-sol` / `max` review with no remaining finding.
- [x] Archive the plan and write the final changelog and review records.

## Validation and residual risk

- The focused final gate passed 45 files and 261 tests with one opt-in credentialed live smoke
  skipped. Typecheck, production build, logger check, and diff check passed.
- The actual built worker was exercised under Electron's SQLite ABI and remained responsive through
  a production-sized 10,000-row materialization.
- The full current worktree had one unrelated renderer test failure from concurrent present-plan
  edits. That scope was excluded from this plan, review, staging, and commit.
- Checkpoint generation remains provider-bound and can fail or time out. The prior validated head,
  bounded raw tail, partial-prefix coverage marker, and later automatic retry remain the honest
  fallback; coverage is never fabricated.

## Completion

The automatic lifecycle, bounded canonical state, provider defaults, summary toggle, budget
documentation, worker isolation, regression coverage, and independent review are complete. The
installed Agent Deck process must be restarted or rebuilt before its current main process uses this
delivery.
