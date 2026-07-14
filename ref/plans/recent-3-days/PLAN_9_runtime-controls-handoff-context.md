---
plan_id: PLAN_9
title: Runtime controls and hand-off context coverage repair
status: completed
created_at: 2026-07-14
updated_at: 2026-07-14
completed_at: 2026-07-14
base_branch: main
base_commit: f10b04391299b85b620ea08466dc951b1b3bec3d
related_changelog: CHANGELOG_363
related_review: REVIEW_158
---

# PLAN_9_runtime-controls-handoff-context: Automatic runtime controls and reliable continuation coverage

## Goal and invariants

- Remove the explicit next-turn apply action and save active-session model/Thinking edits automatically
  without interrupting the current provider reply.
- Diagnose and repair hand-off Continuation Context degradation using installed application evidence.
- Preserve same-adapter runtime inheritance, immutable source capture, trusted initial-turn delivery,
  mandatory task/team/worktree transfer, and honest coverage-gap fallback.
- Preserve the existing `.agent-deck/` workspace state and unrelated changes.

## Confirmed scope and decisions

- Renderer work was limited to `SessionRuntimeControls.tsx` and its focused composer tests. Model text
  changes coalesce for 250 ms; Thinking changes persist the latest combined snapshot immediately.
- Continuation work stayed under `src/main/session/continuation-context/**`. UI and MCP share the same
  repair; missing-history recovery keeps its separate deadline.
- The two implementation tracks used disjoint write sets and returned evidence to the lead for shared
  documentation, integration, and full validation.
- Runtime inheritance and Continuation Context quality were treated as separate hypotheses; provider
  rollout evidence disproved runtime downgrade while logs and DB state proved checkpoint coverage loss.

## Completed checklist

- [x] Read repository, adapter, UI-copy, parallel-dispatch, and browser-control instructions.
- [x] Correlate MCP hand-off logs, DB lineage, source telemetry, and Codex turn contexts.
- [x] Obtain user approval for two bounded parallel tracks and record personal task progress.
- [x] Implement automatic race-safe runtime persistence and remove the explicit button.
- [x] Reproduce the 120-second checkpoint timeout and prove the old fold budget cannot catch up.
- [x] Compact duplicate telemetry, rebalance fold input, extend only hand-off's deadline, and add safe diagnostics.
- [x] Add renderer, production-shaped fold, budget, hand-off, and service regressions.
- [x] Update README behavior documentation and create/rebucket final plan, changelog, and review records.
- [x] Pass focused and full Electron tests, typecheck, build, logger, diff, LOC, review-expiry, and record-hook checks.
- [x] Attempt browser verification without terminating the installed application that owns this session.

## Validation and residual risk

- Full repository gate: 286 test files and 2,675 tests passed; one opt-in credentialed live smoke was skipped.
- Production reconstruction found checkpoint revision 40 against capture revision 4,426. The isolated
  Codex/high call timed out at 120.445 seconds and succeeded in 201.154 seconds with a 240-second limit.
- Browser connection failed inside the bundled client on a non-redefinable `process` property; focused
  React tests cover the visible behavior, and the running installed host remained untouched.
- A semantic repair after a slow first generation may still exhaust the 300-second hand-off deadline.
  The last valid checkpoint plus immutable raw tail remains authoritative in that bounded fallback.

## Completion

Both approved tracks are integrated. Documentation, regression coverage, full validation, and final
records are complete. No successor action remains except safely restarting/rebuilding Agent Deck before
expecting the installed main process to exercise the new hand-off behavior.
