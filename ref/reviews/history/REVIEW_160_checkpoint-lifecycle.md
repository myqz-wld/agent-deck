---
review_id: 160
reviewed_at: 2026-07-14
baseline_commit: b64566618c64018c3343a6ae4f459ca2bf41f6bd
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused review covers only the machine-readable automatic checkpoint, summary, settings, store, and lifecycle scope below."
---

# REVIEW_160_checkpoint-lifecycle: Automatic bounded continuation checkpoints

## Scope and method

A standalone `gpt-5.6-sol` / `max` reviewer performed multiple read-only rounds against the shared
tree. It inspected lifecycle and revision semantics, SQLite/CAS boundaries, worker dependency
closures, main-loop performance, canonical eviction, settings migration, IPC/UI behavior, and the
actual emitted worker. Every HIGH/MEDIUM finding was fixed and re-reviewed; the final round reported
zero material findings at every severity. Concurrent present-plan/deep-review changes were explicitly
excluded.

```review-scope
README.md
src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts
src/main/adapters/codex-cli/summarizer-runner.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/__tests__/checkpoint-event-lifecycle-entry.test.ts
src/main/index/__tests__/checkpoint-shutdown-entry.test.ts
src/main/ipc/__tests__/settings-continuation.test.ts
src/main/ipc/settings-continuation-validation.ts
src/main/ipc/settings.ts
src/main/session/__tests__/summarizer-runner.test.ts
src/main/session/continuation-context/__tests__/checkpoint-background-materializer.test.ts
src/main/session/continuation-context/__tests__/checkpoint-background-refresh.test.ts
src/main/session/continuation-context/__tests__/checkpoint-background-worker-client.test.ts
src/main/session/continuation-context/__tests__/checkpoint-background-worker.integration.test.ts
src/main/session/continuation-context/__tests__/checkpoint-backlog-estimator.test.ts
src/main/session/continuation-context/__tests__/checkpoint-backlog-worker-client.test.ts
src/main/session/continuation-context/__tests__/checkpoint-canonical-fit-overflow.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-chunk.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-overflow.test.ts
src/main/session/continuation-context/__tests__/checkpoint-overflow-fixtures.ts
src/main/session/continuation-context/__tests__/checkpoint-refresh-scheduler.test.ts
src/main/session/continuation-context/__tests__/checkpoint-refresh-service.test.ts
src/main/session/continuation-context/__tests__/resolver.test.ts
src/main/session/continuation-context/__tests__/source-spool.test.ts
src/main/session/continuation-context/checkpoint-background-materializer.ts
src/main/session/continuation-context/checkpoint-background-refresh.ts
src/main/session/continuation-context/checkpoint-background-worker-client.ts
src/main/session/continuation-context/checkpoint-background-worker-contract.ts
src/main/session/continuation-context/checkpoint-background-worker.ts
src/main/session/continuation-context/checkpoint-backlog-estimator.ts
src/main/session/continuation-context/checkpoint-backlog-worker-client.ts
src/main/session/continuation-context/checkpoint-backlog-worker-contract.ts
src/main/session/continuation-context/checkpoint-backlog-worker.ts
src/main/session/continuation-context/checkpoint-canonical-fit.ts
src/main/session/continuation-context/checkpoint-fold-chunk.ts
src/main/session/continuation-context/checkpoint-fold-source.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-refresh-scheduler.ts
src/main/session/continuation-context/checkpoint-refresh-service.ts
src/main/session/continuation-context/handoff.ts
src/main/session/continuation-context/recovery.ts
src/main/session/continuation-context/resolver.ts
src/main/session/continuation-context/source-spool-raw-tail.ts
src/main/session/continuation-context/source-spool.ts
src/main/session/summarizer/__tests__/llm-runners-defaults.test.ts
src/main/session/summarizer/__tests__/summary-enabled.test.ts
src/main/session/summarizer/index.ts
src/main/session/summarizer/llm-runners.ts
src/main/store/__tests__/continuation-checkpoint-repo.test.ts
src/main/store/__tests__/event-revision-repo.test.ts
src/main/store/__tests__/settings-store-continuation.test.ts
src/main/store/continuation-checkpoint-read.ts
src/main/store/continuation-checkpoint-repo.ts
src/main/store/event-revision-read.ts
src/main/store/event-revision-repo.ts
src/main/store/settings-store.ts
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/shared/types/settings.ts
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
```

## Finding history and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A queued eligibility revision could become empty after an in-place tool-row revision update, yet the old design could claim coverage through that frozen boundary. | Capture now occurs at execution against the latest durable WAL snapshot, and commit validates the latest head plus rebuild epoch. The R→R+1 tool completion race is covered. |
| HIGH | Backlog estimation and then source materialization/normalization could synchronously process tens of MiB or hundreds of thousands of rows on Electron main. | Both stages moved to read-only workers. Materialization is capped at 10,000 rows / 32 MiB and the production integration proves main-loop progress. |
| HIGH | The first emitted background worker imported main-only repository infrastructure, causing Electron/logger/migration code to run in a Node worker before `ready`. | DB-injected worker-safe readers replaced the facades. Recursive bundle inspection and an actual emitted-worker Electron launch are clean. |
| MEDIUM | Busy/idle classification mishandled active `waiting` turns and dormant sessions retaining `working`, violating normal-refresh gates. | Eligibility derives activity together with lifecycle/event boundaries; active waiting remains busy and dormant/finished sessions can refresh. |
| MEDIUM | Canonical eviction was section-first, so an early completed fact could outlive a newer, higher-value resolved fact in a later section. | Optional facts are globally sorted by status, priority, recency, section, and id; cross-section overflow tests pin the order. |
| MEDIUM | The continuation refresh regression itself did not typecheck because callback mutation narrowed a deferred resolver to `never`. | The test uses a trackable typed deferred boundary; focused and repository typecheck gates pass. |
| MEDIUM | Even after asynchronous estimation, immutable source capture plus first-pass normalization still performed synchronous heavy work on Electron main. | Latest-at-execution capture, normalization, and chunk building moved into the materializer worker with bounded wire DTOs. |
| MEDIUM | Normalizing a binary-search candidate window let an unconsumed tool-end suppress a tool-start inside the actually committed prefix. | The worker monotonically rebuilds from the exact consumed raw prefix until stable, then applies the wire guard. The original r1/r10 counterexample passes. |
| LOW | `summaryModel` lacked IPC type/length validation and malformed persisted-value repair. | Validation now mirrors checkpoint model fields and settings migration repairs malformed values while preserving valid blanks. |
| LOW | Settings copy omitted distinct observed-window, reserve, clamp, fallback, and 512 KiB byte limits. | Settings and README now explain every budget and their allocation order separately. |
| LOW | Bootstrap/start/stop and event lifecycle wiring lacked entry-level coverage. | Mocked entry tests cover bootstrap, restart scans, rename/delete events, normal shutdown, and timeout ownership. |
| LOW | Pre-ready stop, message errors, abnormal exit, and native termination lacked a hard client ownership boundary. | Worker clients expose termination, watchdog readiness/close, settle queued work, and retain ownership until exit. |
| LOW | The canonical comparator applied stable id before section rank, making the documented section tie-break unreachable. | Comparator ordering is now status/priority/recency, section rank, then id with an equal-tuple regression. |
| LOW | Abort could begin native termination while a late `ready` still resolved the opening. | A synchronous terminal flag precedes termination; every later message is ignored and rejection waits for the exit boundary. |

The first review also reported a HIGH failure in concurrently edited plan-review code. It was outside
this checkpoint scope, was excluded from all counts above, and was neither staged nor changed here.

## Final reviewer verification

- Final result: 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW material findings; gate `PASS`.
- The emitted worker's recursive local require closure contains only the worker, worker contract, and
  fold-chunk bundle; no `electron`, `electron-log`, migrations, `setName`, or main repo facade.
- The production integration launches the actual `?nodeWorker` output, rejects corrupt generation 2
  in favor of valid generation 1, materializes the complete bounded prefix with heartbeat progress,
  serves a chunk, and exits zero.
- The original exact-prefix and abort/late-ready reviewer counterexamples both pass after the fixes.
- The reviewer reran focused Electron-ABI suites, store paging tests, typecheck, diff checks, and the
  production dependency-closure scan.

## Lead validation and deployment note

- The final focused suite passed 45 files / 261 tests with one opt-in live smoke skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed; implementation
  files remain within the repository's 500-line rule.
- The full current-tree invocation had one concurrent out-of-scope `PlanDeepReviewDialog` assertion
  failure; all 2,793 other tests passed and the failure reproduced alone.
- The installed host was not terminated from the active SDK session. Restart or rebuild Agent Deck
  before expecting the running main process to use the new worker lifecycle.
