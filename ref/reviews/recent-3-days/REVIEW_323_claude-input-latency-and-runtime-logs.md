---
review_id: 323
reviewed_at: 2026-10-14
baseline_commit: cfa43ce9dd64450859f48346d9ff069b2a3006b3
expired: false
---

# Claude input acknowledgement latency and runtime logs

## Scope and method

The owner reports roughly 5–10 seconds of pending input on another machine, both when Claude is
idle and when adding input during work. Investigation covered the local source, installed SDK
0.3.296, a synthetic loopback model endpoint, and local application logs for October 11–13.
The affected machine's runtime version, provider route, and logs were not available. Local log
observations do not establish the cause of that machine's delay.

This is a bounded debugging audit, without independent paired reviewers. The review-expiry
helper exited while traversing an existing review scope. Latest covering baselines, commit
counts, and churn were inspected directly for all changed files; previous coverage did not
exempt any changed file from inspection.

```review-scope
src/clients/ssh/frame-writer.test.ts
src/clients/ssh/frame-writer.ts
src/hosts/server-core/provider-claude-stream-host.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
```

## Findings and fixes

1. MEDIUM: the idle-input acceptance fallback waited for a complete assistant block when the
   provider omitted correlation metadata or rewrote the user UUID. The application could keep
   input pending throughout an extended thinking block even after receiving response-start
   events. A valid top-level assistant `message_start` now establishes idle-input acceptance.
   Mid-turn submissions still require matching UUID correlation; pings, content deltas,
   malformed starts, subagent events, and explicitly mismatched IDs cannot acknowledge input.
2. HIGH: an SSH write failure could escape as an unhandled `EPIPE`. Node invokes the write
   callback before emitting the stream's `error` event. The writer removed its error listener
   from the callback failure path, leaving the subsequent event unhandled. The existing test
   installed its own no-op listener and therefore missed the defect. Closed writers now retain
   their error guard through stream closure, clean it up on `close`, and report failure once.
   Explicit writer closure also absorbs an outstanding write's late error without reconnecting
   or reporting a second failure. This repair handles a disconnect; it does not prevent the
   underlying network or heartbeat failure.
3. Slow Claude input lacked stage timing. Deferred inputs now retain in-memory preparation and
   SDK-submission timestamps. Acceptance taking at least two seconds reports a diagnostic through
   the Desktop and Server Core host ports with `appQueueMs` and `sdkAcceptanceMs`, frame type,
   and correlation identifiers. Desktop persists it. The subsequent server-side investigation
   below found that default Server Core logging still drops informational entries and provider
   detail values; that sink limitation is not repaired by the host callback alone.
   No prompt text, attachment data, paths, or credentials enter this diagnostic.
   Fast input stays quiet; logging failure cannot block acknowledgement or queue wake-up.

`appQueueMs` starts when the lazy provider message is created and includes local waiting and
attachment materialization. It excludes earlier IPC/transport and recovery preparation.
`sdkAcceptanceMs` starts when the iterator yields the message and ends on accepted provider
output; it can include SDK work, hooks, upstream first-byte latency, or active-turn scheduling.
It is not a direct measurement of network time. Cancelled inputs or inputs that never receive
acceptance produce no acceptance timing record.

## SDK experiment

A disposable SDK process used a synthetic loopback API, synthetic credentials, an isolated
configuration directory, no user/project settings, and no tools. No paid provider call or
existing application session was used. The disposable query, endpoint, and directory were
cleaned up after the experiment.

| Input | Send-to-replay acknowledgement |
|---|---:|
| First input, including process initialization | About 666 ms |
| Follow-up submitted after a result | 19 ms |
| Correction submitted during streaming | 18 ms |

Replay acknowledgement arrived with the beginning of the mocked API response, before the
deliberately delayed completion of its content block. This setup shows no fixed 5–10 second
queue delay in the current SDK. Real provider startup/first-byte latency remains unmeasured.
The [official streaming-input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
describes the persistent input mode; the concrete timing evidence above comes from the local
experiment, not a live-provider benchmark.

## Recent local log observations

The three-day snapshot contains 179 informational entries, 75 warnings, and 5 errors.

| Observation | Evidence and disposition |
|---|---|
| Remote transport instability | 46 degraded-state records, all on October 12: 29 pong timeouts, 13 SSH bridge exits, 2 remote closes, 1 handshake timeout, and 1 EPIPE. These are diagnostic records, not necessarily distinct outages. There were 32 recovery records, with median recovery around 3.9 seconds. Correlate remote endpoint logs before changing heartbeat or retry limits. |
| Unhandled EPIPE | One error at the SSH frame writer. Reproduced and fixed as described above. |
| Snapshot requests during shutdown | Four `service_stopped` errors. The shutdown ingress guard deliberately rejects them; they do not show a running-service request latency defect. |
| Main event loop | Three lag samples of 616, 626, and 711 ms, followed by recovery. The snapshot does not show a recurring 5–10 second main-thread stall. |
| Background summaries | Five slow-success samples, 41.3–129.7 seconds; two continuation checkpoint refreshes took 62.1 and 75.0 seconds. Summary work is asynchronous with bounded concurrency and is not awaited by the input iterator. Shared provider resource contention is not excluded by these logs. |
| Storage maintenance | Worker WAL checkpoints took 54–66 ms; one worker cleanup slice took 105 ms. This is worker activity, not evidence of equivalent main-thread blocking. |
| Other diagnostics | Codex/Grok usage reads degraded or timed out; two Browser context renewals were unavailable. Neither establishes the reported Claude input delay. |

No raw logs, private machine paths, endpoint identities, or configuration payloads were copied
into the repository. Routine logging, quotas, timeouts, and heartbeat settings were preserved.

## Validation

- The idle response-start regression failed before the acceptance repair and passes afterward.
- Removing the test-only SSH error listener reproduced the unhandled error before the repair.
  A real Node Writable regression now covers callback/error/close ordering without such a sink.
- Final focused validation passed: 16 files, 100 tests covering Claude input acceptance,
  streaming, cancellation, consecutive corrections, and all SSH client suites.
- An earlier full `pnpm test` run after the Claude repair passed 1,146 files / 7,164 tests,
  with 3 files / 6 existing opt-in skips. The final full working-tree run after the SSH repair
  reported 1,136 passing files / 7,153 passing tests, 10 failing files / 13 failed tests, and
  the same skips. Concurrent outside-task permission changes were in progress; failures include
  Codex permission option/schema and runtime-control expectations. A final globally green
  working tree is not claimed.
- `pnpm typecheck` passed after the Claude repair. The final check passed architecture/Core
  boundaries but was blocked by outside-task errors: an unused permission import in
  `src/hosts/server-core/runtime-controls.ts` and a missing `permissionMode` option contract in
  `src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts`.
- `git diff --check` passes. All changed source/test files remain below 500 lines.
- Review numbering and time buckets were rescanned; no existing review required rebucketing.
  README changes are unnecessary for these bounded bug fixes and diagnostics.

## Residual risk and activation

These changes cannot eliminate upstream response latency and do not remove the single
unacknowledged-input gate or force interruption of arbitrary provider work. Matching and
cancellation boundaries remain intact. Affected-machine timing and remote heartbeat failures
still require evidence from the relevant runtime after an authorized update.

Source changes have not been packaged, installed, or activated. An affected Desktop instance
requires an updated build and restart; Server Core requires its normal deployment lifecycle.
No live application, Worker, remote service, or user-owned provider process was stopped,
replaced, or restarted. Concurrent changes outside this scope were preserved.

## Server-side follow-up and logging assessment

At the owner's request, read the matching Relay deployment configuration privately and queried
the service journal, container logs, SSH daemon journal, and current SSH keepalive policy.
The application diagnostic instance matched the configured Relay. The interval was explicitly
converted from local PDT to UTC; server display timestamps use UTC+08:00. Commands only read
state and logs. No deployment, service action, configuration edit, or log cleanup was performed.

### Heartbeat evidence

- The service journal for October 11–13 contained nine lifecycle entries, all around October 12
  12:51:07–12:51:11 UTC. They describe a container stop/remove/create/start cycle. The replacement
  started at 12:51:10.965 UTC, or 05:51:10.965 PDT. Desktop recorded recovery at 05:51:16.004 PDT,
  roughly five seconds later. This correlates one interruption with a Relay restart; it does not
  explain the other heartbeat failures or identify why that restart was initiated.
- For October 12 12:00–23:30 UTC, `podman logs` returned no application output. The container uses
  journald; this was not a search of an unrelated file sink. Current container restart count is
  zero since its latest creation, which is not a complete history of earlier containers.
- The SSH daemon journal contained 381 entries in that interval. It did not record a matching
  series of server keepalive timeouts. Observed configuration had no channel/unused-connection
  timeout and `ClientAliveInterval=0`. Therefore the evidence does not support attributing the
  application's pong failures to an SSH-server idle timeout. This does not exclude packet loss,
  intermediate-network idle policies, Worker stalls, or delayed forwarding.
- The application heartbeat defaults are a 30-second ping interval and a 10-second pong wait.
  Current diagnostics do not expose ping write completion, last received data, forwarding queue
  age, or timer scheduling delay, so the existing history cannot distinguish those causes.

### Worker log history

The managed Worker's stderr file contains 100,737,073 bytes (about 96.1 MiB) and 2,052,292 lines.
Its creation date is August 10; its last write was October 12 at 05:30:42 PDT. It includes 226,416
historical `ERR_MODULE_NOT_FOUND` errors for `@iarna/toml`, 27 identical hidden-detail runtime
warnings, and shutdown-timeout messages. Individual entries lack timestamps.

The current launchd job is running, reports one run with no exit in its present registration,
and still points stdout/stderr at those files. The installed worker bundle no longer has an
external `@iarna/toml` import. The large file is historical accumulation; this inspection did not
observe an ongoing startup failure loop. The file was preserved as evidence.

### Improvements identified, not implemented in this read-only follow-up

1. **Restore useful headless diagnostics first.**
   `src/hosts/server-core/runtime-composition-options.ts` discards `info` and renders every warning
   as the same untimestamped hidden-detail sentence. In addition,
   `src/hosts/server-core/provider-host-common.ts` reduces structured detail values to type names.
   Use bounded structured records with UTC timestamp, level, stable event/scope, error category,
   anonymous correlation, and explicitly allowed timing/count fields. Preserve redaction of
   credentials, prompts, attachments, and private paths. This is also necessary for default
   Server Core to persist the newly added Claude acceptance timings.
2. **Add transport transition evidence without logging every ping.** Relay currently has no
   operational heartbeat/forwarding diagnostics. Emit Worker attach/detach, lease expiration,
   stream close/backpressure, and recovery with generation, anonymous connection/stream reference,
   last-receive age, queued bytes, and event-loop delay. Client timeout evidence should distinguish
   queued ping, completed write, elapsed pong wait, and a delayed timeout callback. Rate-limit
   repeats and retain counts plus recovery duration.
3. **Bound Worker service log storage at the launcher boundary.**
   `src/hosts/local-worker/terminal-service.ts` points launchd directly at append-only stdout/stderr
   files, with no application rotation. Retention must cover early Node/module-loader failures
   that occur before runtime logging initializes. Add size/backup limits and repeated-startup
   error aggregation with a count. Existing logs and installed launchd definitions require a
   separately authorized maintenance/activation step; do not truncate them during diagnosis.
4. **Improve severity and correlation in Desktop logs.** Distinguish successful slow summaries
   from failed summaries; ordinary slow-success records can use an informational performance
   event. Keep timeout/failure warnings. Add a run-scoped anonymous session reference, analogous
   to checkpoint-refresh diagnostics, so interleaved summary/recovery events can be paired.
   Treat `service_stopped` snapshot reads as expected only when application shutdown is confirmed;
   retain errors for unexpected service loss.

Desktop already has daily log files, 14-day cleanup, bounded/redacted values, and repeat
aggregation in several subsystems. The observed Desktop volume is small; the evidence supports
fixing missing context and Worker retention before a general logging-throughput rewrite.

No runtime code changed in this follow-up, so no additional code validation was needed. The
earlier implementation/test status above remains separate. The unresolved heartbeat investigation
now requires improved telemetry at the forwarding boundaries, rather than another read of the
same empty Relay application log.

## Authorized logging implementation follow-up

The owner subsequently authorized the logging work and selected 10 MiB plus three backups per
managed Worker output channel, preserving legacy history separately. Source implementation and
full validation are now complete in
`ref/reviews/recent-3-days/REVIEW_324_runtime-log-observability.md` and
`ref/changelogs/recent-3-days/CHANGELOG_678_runtime-log-observability.md`. The installed app, live
Worker and remote Relay remain unchanged, so the original runtime observations above still
describe the pre-activation environment. Other-machine latency and remaining heartbeat causes
remain unproven until new runtime evidence is available.
