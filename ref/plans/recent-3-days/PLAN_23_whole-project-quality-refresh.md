---
plan_id: PLAN_23
title: Whole-project quality refresh
status: completed_with_residuals
created_at: 2026-07-27
updated_at: 2026-07-29
completed_at: 2026-07-29
base_branch: main
base_commit: a63033bdeeecdf3aba0d6d31a5818e5dc41c679a
completed_head: 0428a65aff91e811f770815b2a17f93952434e5d
related_changelog: CHANGELOG_411
related_review: REVIEW_187
---

# PLAN_23_whole-project-quality-refresh: Bounded cross-adapter quality

## Goal and invariants

- Make Claude Code, Codex CLI, and Grok Build lifecycle, permission, persistence, and UI contracts
  explicit without changing their protocol ids or native ownership.
- Fail closed before irreversible provider, database, filesystem, or handoff side effects.
- Replace unbounded synchronous work with measured pagination, batching, projections, or explicit
  offline commands.
- Keep renderer state typed and bounded; mount expensive editors/viewers only on demand.
- Persist only content-free diagnostics with bounded repetition and recovery evidence.
- Keep every changed production source file below 500 lines and keep coupled transactions,
  migrations, and public schemas together.

## Completed task breakdown

- [x] Logging foundation, run identity, safe diagnostics, and Electron host/bootstrap containment.
- [x] Shared expandable renderer shell, payload viewers, composer/session isolation, and
      permission/asset/application-convention authoring.
- [x] Claude Code atomic plugin mirror, Codex CLI bounded control-plane recovery, Grok Build
      transactional runtime mutation, and canonical cross-adapter copy.
- [x] Transactional spawn collaboration, strict MCP output schema, handoff ownership transfer,
      late-message fencing, and shutdown DB-ingress guards.
- [x] Logs IPC hardening, Hook boundary normalization, bounded creation defaults, and targeted
      file-change/image reads.
- [x] Offline resumable V43 History migration, bounded lifecycle/retention, transactional Issue
      appendices, and maintenance termination safety spike.
- [x] State-transition logging for provider usage, MCP startup/HTTP, checkpoints, summarizer,
      event loop, registry, bootstrap, windows, and Claude configuration.
- [x] Prompt/tool contract parity, three-surface spawn output publication, reviewer identity, and
      prompt-asset safety validation.
- [x] Benchmark-gated V55 token rollups and V56 message index; bounded Issue, permission, and team
      scans; task-edge gate closed with evidence.
- [x] Native-host packaging contract and final Claude Code/Codex CLI/Grok Build dependency audit.
- [x] Final changelog, review, plan, and time-bucket rebucketing.

## Key decisions

- Existing pre-V43 and V55 databases do not run heavy migrations during ordinary startup. The app
  returns a typed command directing the user to `migrate:history-search` or
  `migrate:message-dispatch`.
- Raw token ledger remains authoritative. V55 is a revisioned projection only for unbounded daily
  reads; ranged reads stay on raw data and projection failure never serves stale output.
- V56 changes only the pending-order index. Dispatch SQL, FIFO/fairness, claim generation, and
  watcher state remain unchanged.
- The official artifact matrix is native-host only. There is no checked-in CI artifact workflow
  and no supported cross-target packaging contract.
- Worker-thread termination during native SQLite is unsafe. No `Worker.terminate()` or concurrent
  replacement was added.
- Runtime dependency audit updated Codex CLI to `0.146.0` and Grok Build to `0.2.114`; Claude Agent
  SDK `0.3.220` and its directly coupled SDK/protocol versions were already current.

## Validation

- Failure-first tests were recorded for every behavioral batch.
- Final focused runtime/dependency matrix: 15 files / 201 tests passed.
- Final Electron-ABI suite: 466 files passed and one intentional live smoke skipped; 3,996 tests
  passed and one skipped.
- Typecheck, logger check, production build, FTS/migration matrices, prompt/resource validation,
  native Grok preflight, git diff checks, and file-size checks passed.
- `pnpm dist:mac` produced the native arm64 app, DMG, and block map with Claude Agent SDK
  `0.3.220`, Codex CLI `0.146.0`, and Grok Build `0.2.114` packaged.

## Residuals and next actions

- Decide maintenance timeout policy before further code: disable maintenance until restart, or
  move native maintenance into a killable child process with crash recovery.
- Perform live installed-app and three-adapter interactive smoke only after active sessions can be
  closed safely.
- Treat B20 as scoped logging compliance; the deferred B6 watchdog/recycle and owner-scoped legacy
  call sites remain explicit follow-up debt.
- Revisit task-edge persistence only at the measured scale/latency trigger.

## `.ref` classification

The ignored workspace plan
`/Users/wanglidong/Repository/agent-deck/.ref/plans/whole-project-quality-improvements.md` is
intentionally retained as non-final execution evidence because it contains the original 23-batch
write-set map, benchmark gates, and architecture decision history. This archived plan is the
authoritative final status and handoff.

## Final status

Completed on 2026-07-29 with the maintenance terminal-policy and live installed-app smoke
explicitly deferred. No other known in-scope correctness or validation failure remains.
