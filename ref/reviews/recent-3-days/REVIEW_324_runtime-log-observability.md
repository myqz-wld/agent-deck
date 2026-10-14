---
review_id: 324
reviewed_at: 2026-10-14
baseline_commit: aeb0a90f99e8ceba9e3dacad5f0bca7e644137ee
expired: false
---

# Runtime logging implementation audit

## Scope and method

Lead self-audit and automated regression of the logging improvements authorized after REVIEW_323.
The shared checkout contains unrelated permission/runtime work; that work was preserved. Full
validation ran on the shared working tree. No independent reviewers, live process actions,
installation, deployment, or live-log cleanup were part of this delivery.

The review-expiry helper was run but stopped on an existing scope traversal. A separate explicit
scan covered all paths below, their latest recorded baselines, churn, commit counts, and age:
16 were unreviewed, 2 expired, and 8 had prior coverage. Every listed path was inspected anyway.
README coverage applies to its runtime-diagnostics section; concurrent permission documentation
has a separate owner. Earlier Claude acceptance/EPIPE fixes remain recorded in REVIEW_323.

```review-scope
README.md
resources/bin/agent-deck-worker
resources/bin/worker-log-bootstrap.cjs
resources/bin/worker-log-retention.cjs
scripts/worker-log-retention.test.mjs
src/clients/ssh/client-failure-modes.test.ts
src/clients/ssh/connection.ts
src/clients/ssh/connection-heartbeat.ts
src/clients/ssh/frame-writer.ts
src/clients/ssh/heartbeat.ts
src/clients/ssh/heartbeat.test.ts
src/clients/ssh/types.ts
src/hosts/linux-runtime/diagnostic-fields.ts
src/hosts/linux-runtime/runtime-diagnostics.ts
src/hosts/linux-runtime/runtime-diagnostics.test.ts
src/hosts/relay/diagnostic-router.ts
src/hosts/relay/diagnostic-router.test.ts
src/hosts/relay/headless-root.ts
src/hosts/server-core/provider-host-common.ts
src/hosts/server-core/runtime-composition-options.ts
src/main/remote-host/registry.ts
src/main/session/summarizer/logging.ts
src/main/session/summarizer/__tests__/logging.test.ts
src/main/utils/logger.ts
src/main/utils/remote-shutdown-log-state.ts
src/main/utils/__tests__/logger-remote-shutdown.test.ts
```

## Findings and fixes

1. MEDIUM: headless info was discarded and warnings were identical un-timestamped strings.
   Provider details were reduced to type names, losing the Claude queue/SDK timing evidence.
   The shared default now keeps approved numeric/boolean fields, fixed categories and anonymous
   references, with bounded repeat aggregation. Unknown text is fingerprinted, and serialization,
   clock, sink, and stderr backpressure failures cannot fail runtime work.
2. MEDIUM: managed Worker launchd output had no retention and ESM loader failures bypassed all
   application diagnostics. The previously observed historical stderr was about 96 MiB and over
   two million lines. Retention now runs before ESM import, preserving legacy history separately
   and bounding ordinary JavaScript output. Loader failures aggregate across process attempts.
3. MEDIUM: timeout logs could not distinguish local timer lag, an unwritten ping, recent inbound
   traffic, or Relay lease loss. Failure-time transport/lease evidence now preserves those facts
   without changing heartbeat thresholds, routing decisions, payloads, or reconnect ownership.
4. LOW: successful slow summaries and expected shutdown snapshot errors inflated warning/error
   counts. Slow success and recovery now use info; only expected file-log shutdown errors are
   suppressed. Genuine runtime faults retain their severity and visibility.

## Validation and evidence

- Typecheck and architecture checks passed.
- Full suite: 7,217 tests passed, 6 skipped across 1,154 passing and 3 skipped files.
- Regression coverage includes real writable callback/error ordering from REVIEW_323; a blocked
  heartbeat and throwing observer; synchronous pongs and stopped timers; Relay lease expiry,
  reconnect timing, fenced streams, payload exclusion, and failing diagnostic sinks; safe provider
  metrics, unknown/error text redaction, phase distinction and repetition; summary severity and
  shutdown-only filtering.
- Nine retention/bootstrap tests cover inode preservation, legacy history, three-backup limits,
  hostile symlinks, mismatched descriptors, failed publication retry, complete JSON record writes,
  startup aggregation across subprocesses, exit-code preservation, and non-fatal retention failure.
- Desktop build and all 11 headless roles built successfully. Headless double-build hashes matched;
  isolated Worker/Feishu bundle checks passed. Existing dependency bundler warnings remain.
- A separate isolated check loaded the actual Worker bundle through the shipped bootstrap without
  checkout dependencies, then rejected synthetic invalid config before starting any service.
- `bash -n`, Node CJS syntax checks, diff whitespace, resource inclusion mapping, <=500-line checks,
  and personal-home-prefix scans on source and generated build artifacts passed.

## Safety review

- The bootstrap uses Node built-ins and dynamic import in the existing process. It adds no
  supervisor, changes no signal ownership, and keeps the runtime's exit code.
- Only inherited descriptors matching owner-only managed Worker log files are rotated. The
  canonical root and file inode are rechecked, symlink/hardlink substitutions are rejected, and
  existing legacy history is never overwritten. A prepared copy precedes rolling-backup eviction;
  incomplete temporary publication is cleaned before retry.
- Headless identifiers are HMAC references scoped to one process. Only approved operational
  scalars survive filtering; messages, stacks, paths, credentials and forwarded bytes are absent.
  Healthy heartbeat traffic does not emit per-tick records.
- Startup repeat state contains only a fixed error code, timestamp, and counter in a private file.
  A logging failure does not own Worker/transport lifecycle or prevent shutdown/reconnection.

## Residual risk

- The other-machine Claude delay and historical heartbeat failures still require evidence after
  rollout. Source-only fixes have no effect on currently running app/Worker/Relay instances.
- `.legacy` preserves prior history outside the 80 MiB combined rolling budget and is never
  automatically deleted. First adoption copies it synchronously before Worker initialization;
  later rotation copies at most 10 MiB. This preserves evidence at the cost of bounded file I/O.
- Rotation covers managed JavaScript writes. Native fatal output or direct descriptor writes can
  bypass the stream wrapper. Disk/ownership failures fall back to original output with one warning
  per channel per process, so retention is best-effort under those failures.
- A crash after legacy publication but before its marker safely refuses a later automatic adoption
  rather than truncating uncertain history; it emits the retention-unavailable category.
- Repeat summaries are emitted on the next matching occurrence after the minute, not by a periodic
  timer. Unknown events remain content-free fingerprints; new operational categories should be
  explicitly added when their safe fields are understood. Anonymous IDs differ between processes.

## Follow-up boundary

Activation requires an independently authorized update/restart of the exact app, Worker and Relay
components. Preserve current installed state and history until that action is requested. Release
packaging/signing and live verification were not run. See `CHANGELOG_678_runtime-log-observability.md` in
`ref/changelogs/recent-3-days/` and `PLAN_89_runtime-log-observability.md` in `ref/plans/recent-3-days/`.
