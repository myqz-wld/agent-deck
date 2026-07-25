---
review_id: 162
reviewed_at: 2026-07-15
baseline_commit: 0afedd5cf32d76fd839e7453df790a7d88bc24f5
expired: false
skipped_expired: []
---

# REVIEW_162_runtime-log-signal-and-recovery: Runtime log signal and recovery

## Scope and method

This review sampled the three most recent application-log days (`2026-07-13` through
`2026-07-15`), grouped structured entries by scope, level, and message, and traced the dominant
warnings and sole error back through production control flow. The review covered logging policy,
checkpoint-refresh retry behavior and diagnostics, MCP latency classification, and Electron
top-level navigation containment.

```review-scope
src/main/adapters/codex-cli/app-server/client.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.test.ts
src/main/adapters/codex-cli/app-server/thread-boundary-logging.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-failure.test.ts
src/main/session/continuation-context/__tests__/checkpoint-refresh-scheduler.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/checkpoint-background-refresh.ts
src/main/session/continuation-context/checkpoint-fold-failure.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-refresh-backoff.ts
src/main/session/continuation-context/checkpoint-refresh-scheduler.ts
src/main/session/continuation-context/checkpoint-refresh-service.ts
src/main/window/__tests__/navigation-policy.test.ts
src/main/window/lifecycle.ts
src/main/window/navigation-policy.ts
```

## Log evidence

- The sample contained 7,768 top-level records: 7,295 info, 472 warning, and one error. The
  `codex-app-server` scope produced 7,100 records.
- Routine accepted-turn watchdog lifecycle emitted 2,231 `armed` and 2,230 `first model event`
  info records. Thread start/resume success emitted about 2,038 more records; only 13 took at least
  60 seconds, while 1,724 completed below 30 seconds.
- All 22 `slow MCP HTTP request` warnings were long-lived collaboration operations:
  `present_plan` (11), `spawn_session` (8), or `hand_off_session` (3). The presentation duration was
  predominantly human decision time, not HTTP handler latency.
- Checkpoint refresh emitted 180 lower-level fold warnings and 178 matching scheduler warnings.
  A repeated session remained on the same checkpoint revision while the capture revision grew,
  proving a no-progress retry loop rather than new failures with new coverage.
- The only error was an Electron navigation to a source-location `file://` URL ending in
  `checkpoint-schema.ts:5`, which replaced the application renderer and failed with
  `ERR_FILE_NOT_FOUND`.

## Confirmed findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A validation-limited checkpoint fold could retry every five minutes without progress, repeat provider work, emit two warnings per attempt, and discard the exact validation class. | Preserve a bounded failure diagnostic, emit one owning warning with safe reason/provider/revision/retry fields, and exponentially back off only repeated no-progress failures to a six-hour cap. Any checkpoint progress resets the streak. |
| MEDIUM | Normal Codex accepted-turn and thread-boundary lifecycle messages dominated persisted info logs and obscured actionable signals. | Demote routine watchdog and sub-30-second thread-ready records to debug; retain watchdog timeouts and promote only thread boundaries of at least 30 seconds as performance warnings. |
| MEDIUM | Renderer link/source-location navigation could replace the single application window, producing the sample's sole error and making the UI unavailable. | Prevent every top-level navigation and new-window request; open only `http:`, `https:`, and `mailto:` targets through the OS and block file, script, and invalid targets. |
| LOW | Human-gated and provider-lifecycle MCP calls were classified by the ordinary 500 ms HTTP threshold. | Exempt presentation gates, use 60 seconds for spawn, 180 seconds for handoff, and retain 500 ms for ordinary RPC/tool calls. |

The existing summary-timeout fallback, event-loop lag, slow persistence, WAL checkpoint, and rare
interrupt-versus-shutdown warnings remain unchanged: they were low-volume, actionable, or already
described successful fallback behavior rather than redundant routine telemetry.

## Validation

- `pnpm test`: 315 files and 2,873 tests passed; one credentialed live smoke test remained skipped.
  The SQLite suite ran with Electron's native ABI before the prescribed native dependency restore.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Focused regressions cover the 30-second thread boundary, watchdog debug level, tool-aware MCP
  thresholds, failure-reason redaction, no-progress exponential backoff/progress reset, and external
  navigation allowlist.
- Every changed production TypeScript file remains at or below 500 lines; the largest are
  `client.ts` at 498 and `checkpoint-refresh-scheduler.ts` at 497.

## Residual risk and deployment note

- Historical logs did not preserve the provider validation message, so the exact old checkpoint
  rejection reason cannot be recovered. Future attempts now record a stable safe reason without
  persisting provider output or fact identifiers.
- Checkpoint prompt assets were inspected but not changed: the available evidence supports retry and
  diagnostic defects, not a specific prompt correction.
- This modifies Electron main-process behavior. The currently running Agent Deck instance owns the
  active SDK session, so it was not restarted during review; a normal application restart is required
  to load the fixes.
