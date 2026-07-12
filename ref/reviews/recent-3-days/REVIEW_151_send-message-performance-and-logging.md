---
review_id: 151
reviewed_at: 2026-07-11
baseline_commit: c89f5a5591d796bffc768d53cb5fdedd9e5bc77f
expired: false
skipped_expired: []
---

# REVIEW_151_send-message-performance-and-logging: Send latency, storage, and runtime logging

## Scope and Method

This standalone lead review investigated the reported 8–10 second `send_message` latency, audited
the main-process, database, watcher, and renderer performance boundaries, and inspected the Agent
Deck logs from 2026-07-08 through 2026-07-11. Per the user's request, it did not invoke the
`simple-review` or `deep-review` workflows or reviewer agents.

```review-scope
src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/index/__tests__/_deps.test.ts
src/main/index/_deps.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/session/lifecycle-scheduler.ts
src/main/session/manager/sdk-pending-claim.ts
src/main/store/event-repo.ts
src/main/utils/__tests__/logger-end-to-end.test.ts
src/main/utils/__tests__/logger.test.ts
src/main/utils/__tests__/main-event-loop-monitor.test.ts
src/main/utils/logger.ts
src/main/utils/main-event-loop-monitor.ts
```

## Result

PASS for the low-risk observability and logging changes. No message protocol, delivery-state,
authorization, or schema behavior changed.

Severity distribution:

- CRITICAL: 0
- HIGH: 1 structural performance risk tracked for a measured migration
- MEDIUM: 2 fixed; 1 structural storage risk tracked
- LOW: 2 audit candidates dispositioned pending profiling evidence

## Latency Boundary

The slow samples are not slow message enqueue or delivery operations.

SQLite contains 833 successful paired `mcp__agent-deck__send_message` tool calls:

| Metric | Value |
|---|---:|
| p50 | 177 ms |
| p90 | 1,142 ms |
| p95 | 1,626 ms |
| p99 | 3,272 ms |
| max | 9,418 ms |
| calls at or above 8 seconds | 2 |

The two outliers occurred in independent `gpt-5.6-sol` sessions and recovered at nearly the same
wall-clock time:

| Started | Tool duration | Start to message `sentAt` | `sentAt` to tool end |
|---|---:|---:|---:|
| 2026-07-11 11:07:18 | 9,418 ms | 9,413 ms | 5 ms |
| 2026-07-11 11:07:20 | 8,335 ms | 7,863 ms | 472 ms |

Native Codex rollout telemetry independently reports 9.416 and 8.334 second MCP calls. In both
results the server-generated `sentAt` is near the end, so almost all observed time elapsed before
the message row was written. Their simultaneous recovery makes a shared client/app-server or
Electron main-loop stall plausible, but does not prove which side stalled.

Counter-evidence against the queue itself:

- Direct calls to the running HTTP MCP endpoint completed in milliseconds. A 200-request invalid
  no-write concurrency probe measured p95 4.0 ms, p99 6.6 ms, and max 6.7 ms.
- A separate 303-sample 50 ms cadence probe measured max 4.203 ms and zero requests at or above
  100 ms while a large tool-result event was ingested.
- All 1,409 persisted messages are delivered. End-to-end `delivered_at - sent_at` is p50 38 ms,
  p90 58 ms, p95 61 ms, p99 65 ms, and max 75 ms.

The existing synchronous handler correctly returns after durable enqueue; the watcher delivers
asynchronously. No queue-state or watcher timing change is justified by this evidence.

## Findings

### HIGH tracked: unbounded full-payload trigram FTS dominates the live database

The live database is approximately 1.7 GB with 180,068 events. `dbstat` attributes:

- `events_fts_data`: 1,019.0 MiB
- `events`: 428.4 MiB
- `file_changes`: 288.8 MiB
- `idx_events_session`: 14.3 MiB

The FTS triggers index the complete `payload_json`. Tool-end payload text alone is 279.4 MiB, with
individual payloads up to 197,149 characters. These triggers are maintained by synchronous
better-sqlite3 writes on Electron's main process. This is the leading global-stall risk, but the
outlier samples do not prove an FTS write caused either stall.

A live index rebuild or destructive retention change was deliberately not attempted. A safe fix
needs a copied production-size database, a search-specific/bounded indexing design, retention
semantics, migration rollback, disk-headroom checks, and measured startup/write/search latency.
Tracked issue: `b9de1e61-3a8c-41f4-a58d-2adb2bb17dea`.

### MEDIUM tracked: full before/after file snapshots amplify storage

The 10,493 `file_changes` rows contain approximately 249.7 MiB of snapshot text. Every change
stores complete `before_snapshot` and `after_snapshot` values. One frequently changed file,
`ref/changelogs/INDEX.md`, accounts for 119 rows and 54.9 MiB alone. There are 7,400 distinct
before snapshots and 9,498 distinct after snapshots, leaving meaningful content-addressing or
compression opportunity.

This also needs a designed schema/read-path migration rather than an in-place audit patch. Tracked
issue: `344e5a14-9eae-4c52-851f-eb1ae535e102`.

### MEDIUM fixed: logs could not distinguish client delay, main-loop stall, HTTP work, and FTS work

The prior runtime had no slow MCP request timing, event-loop delay signal, or slow event-persistence
timing. A future outlier would reproduce the symptom without identifying its boundary.

The landed instrumentation adds:

- A 250 ms main-event-loop drift monitor. It warns at 500 ms, rate-limits repeated warnings for
  10 seconds, and ignores delays at or above 60 seconds as likely system suspend/wake.
- MCP HTTP response timing. Requests at or above 500 ms log the JSON-RPC method, tool name, caller
  short id, response status, and duration. Tool arguments and message content are never logged.
- Event persistence timing. Writes at or above 250 ms log duration, insert/merge operation, event
  kind, session short id, payload character count, and tool-id presence without payload content.
- Orderly shutdown of the event-loop monitor.

Interpretation for the next incident:

- event-loop warning plus no slow MCP entry: request likely waited before the route ran;
- slow MCP plus no event-loop warning: asynchronous handler/client response work was slow;
- slow event persistence plus event-loop warning: synchronous SQLite/FTS work blocked main;
- none of these plus a slow native tool duration: investigate the Codex client/app-server boundary.

### MEDIUM fixed: routine noise obscured the small warning/error set

The four inspected log files contain 859 lines: 720 info, 16 warn, and 5 error. Two routine success
messages account for 547 lines (63.7%): 422 SDK pending-claim lines, mostly the ten-minute provider
quota probe, and 125 one/two-session history purge lines. Both are now debug-level.

All five error rows were the deterministic Claude SDK
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` bypass-mode warning, not application failures. An exact
two-anchor file-transport filter now drops only that warning from persisted logs while preserving
it in the development console. String and Node `Warning` object shapes are covered.

The review did not suppress actionable warnings:

- 10 Codex periodic-summary timeouts retained their fallback warning. Current source aborts the
  timed-out ephemeral run and falls back; no accumulation or crash was observed.
- 3 Claude `Not logged in` warnings are external authentication state.
- 2 Codex interrupt-versus-client-close warnings are shutdown races and remain visible because
  their frequency is low and the exact lifecycle context can still aid diagnosis.

No crash, SQLite corruption, delivery failure, or unhandled application error was present in the
four-day log window.

### LOW dispositioned: fixed 250 ms watcher fallback polling

The watcher performs an indexed eligibility scan every 250 ms even when idle, approximately
345,600 fallback scans per day. The event-triggered 50 ms path handles ordinary new messages, so an
adaptive idle backoff could reduce wakeups. Current delivery max is only 75 ms, and changing retry
or crash-recovery latency is not warranted without CPU/wakeup profiling. Leave behavior unchanged
until that profile exists.

### LOW dispositioned: renderer event retention and non-virtualized activity feed

The renderer clones the recent-event map on each event, keeps up to 200 events per session, and can
render a 200-row activity feed without virtualization. A selected/unselected two-tier cache and
virtualization may help large fleets, but no renderer frame or heap evidence tied these paths to the
reported send latency. Profile before changing store semantics.

## Fixes Landed

- Added bounded, content-safe event-loop, MCP HTTP, and event-persistence slow-path logging.
- Added lifecycle ownership and deterministic tests for the event-loop monitor.
- Added safe JSON-RPC request labeling tests that prove tool arguments are not retained.
- Demoted high-frequency SDK claim and routine purge success logs to debug.
- Removed the known Claude bypass SDK warning from persisted error logs with exact matching and
  real `electron-log/node` file-transport coverage; console visibility remains unchanged.
- Registered separate high/medium follow-up issues for the two migrations that require measured
  production-size design work.

## Validation

- `pnpm typecheck`
- Focused monitor, logger, MCP transport, event repository, and scheduler tests passed.
- Full Electron suite: 255 files / 2,447 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Production files remain below the 500-line guardrail; `event-repo.ts` is 489 lines.

## Residual Risk

- The new evidence exists only after rebuilding and restarting the installed application. The
  running app was not terminated or overwritten because it hosts this active session.
- MCP timing begins when the Fastify route runs. It cannot measure time already spent inside a
  provider client before the HTTP request reaches Electron; the event-loop signal and native
  rollout timing are intentionally complementary.
- Thresholds are conservative starting points. Revisit them only after collecting real slow-path
  samples; avoid lowering them into routine log volume.
- The 1.7 GB database remains unchanged. Its FTS and snapshot growth risks are tracked, not hidden
  by the new diagnostics.
