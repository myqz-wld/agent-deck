---
review_id: 315
reviewed_at: 2026-10-07
baseline_commit: 9a1a27908396980a9b65e113100d952b86196408
expired: false
---

# Bound image upload persistence and diagnose filesystem stalls

## Scope and method

Targeted investigation of the user-confirmed local Codex new-session request at 07:16 on
2026-10-07, followed by the authorized persistence repair. Evidence includes sanitized application
logs, installed build metadata, source tracing, read-only process sampling, a disposable native
filesystem-starvation probe, fault injection, renderer regression, and full repository validation.
No independent paired review was requested or performed.

```review-scope
src/main/ipc/adapters-attachments.ts
src/main/ipc/__tests__/adapters-attachments.test.ts
src/main/store/image-uploads.ts
src/main/store/image-upload-io.ts
src/main/store/image-upload-diagnostics.ts
src/main/store/__tests__/image-uploads.test.ts
src/main/store/__tests__/image-upload-io.test.ts
src/main/store/__tests__/image-upload-diagnostics.test.ts
src/main/store/__tests__/image-upload-threadpool.test.ts
src/renderer/components/__tests__/NewSessionDialog.image-timeout.test.tsx
```

## Findings and repairs

| Severity | Finding | Repair |
|---|---|---|
| HIGH | Image persistence awaited mkdir/writeFile indefinitely before provider creation or ordinary message dispatch. The creation watchdog only logged the phase, leaving the renderer busy indefinitely. | Share one 10-second monotonic deadline across a message's images; reject locally on expiry and preserve the existing renderer draft/retry behavior. |
| MEDIUM | Sibling rollback awaited unlink without a deadline. Returning early from an unfenced persistence promise could also allow a late provider dispatch or orphan write. | Bound unlink to one second, retain ownership of unfinished native operations, fence every subsequent write, and clean failed files only after native write/close settlement. |
| MEDIUM | The available logs identified attachments but could not distinguish directory creation, file opening, writing, closing, or broad native filesystem scheduling trouble. | Record path-free operation IDs, phases, timing, bytes, native request counts, and one coalesced callback-based filesystem probe after a timeout. |

Uploads now open a fresh UUID path exclusively with mode 0600 and write bounded chunks. A failed
exclusive open never authorizes deletion. Partial writes, late opens, and late successful writes
are closed and removed only by their owning attempt. Timed-out input cannot continue to the
provider, and a retry receives a separate path. Error reporting does not wait for a stalled cleanup.
Existing MIME/size/path validation and the stale-upload reaper remain in force.

## Evidence and causal limits

- The installed build matched the source baseline above. The confirmed request entered the main
  process at 07:16:55.620 and logged `phase: attachments` at 07:16:57.626. There was no completion
  before that process shut down. The provider creation call follows this awaited phase.
- From 06:59:15 onward, the same process repeatedly timed out while opening a local Codex config
  through `electron-original-fs`. Several text-only sessions still completed creation in roughly
  24-31 ms. The shared asynchronous file path was already unhealthy before the image request.
- The old process exited at approximately 07:17; the replacement started at 07:17:46. The upload
  directory subsequently contained a new regular image file. Sampling the replacement found idle
  libuv workers, not a surviving blocked worker. This cannot reconstruct the old process's stacks.
- Isolated native Codex image/Gateway checks against synthetic loopback Responses endpoints passed
  for 401, 503, and truncated-stream recovery. The checked requests contained image inputs and
  retained history after changing providers, changing an endpoint under the same provider, and
  restoring native defaults. These checks exclude neither arbitrary remote gateway failures nor
  other unobserved sessions; the confirmed request had not reached its gateway.
- The retained starvation regression blocks one disposable child's one-thread libuv pool on an
  owned FIFO. An unrelated config open, image-directory mkdir, and callback stat all remain pending
  while timers and synchronous reads work. Releasing the FIFO lets every operation finish. This
  reproduces a plausible native mechanism, not the historical occupant or trigger.
- libuv documents that filesystem work shares a process-global pool, including across event loops:
  [libuv thread pool](https://docs.libuv.org/en/v1.x/threadpool.html). Therefore changing to a
  callback, `original-fs`, or another async worker-thread wrapper alone does not prove isolation
  from pool starvation. No speculative runtime upgrade or synchronous-main-thread workaround was
  applied.

The confirmed application defect was an unbounded wait on unhealthy asynchronous filesystem work.
The exact historical native cause (blocked pool work, delayed completion delivery, or another
runtime condition) remains undetermined because the affected process and its stack evidence are
gone. No user transcript, image contents, private configuration, or credentials were copied into
this record. Future timeout diagnostics plus a sample taken before restarting are required to
identify the native blocker.

## Validation

- Fault-injection coverage: mkdir/open/write/close timeout; partial and late writes; late native
  rejection; failed exclusive open; retry isolation; shared batch deadline; stalled sibling
  rollback; short writes; expired deadline; coalesced diagnostic probe; logging failure isolation.
- Real filesystem coverage includes a multi-megabyte attachment crossing several write chunks.
- Renderer coverage selects a Codex Gateway, adds an image, receives the timeout, retains the
  exact text/image/Gateway selection, re-enables creation, and retries successfully.
- Existing ordinary composer failure restoration and handoff attachment tests passed.
- `pnpm typecheck` passed architecture and both TypeScript projects.
- Full `pnpm test`: 1,138 files / 7,072 tests passed; 3 files / 6 opt-in or platform tests skipped.
- Final focused pass: 3 files / 18 tests, including a supplemental expired-write completion
  regression where native completion precedes the overdue timer callback.
- `pnpm build` passed. The Electron test runner left the SQLite native binding checksum unchanged.
- Review-expiry inventory was run; changed code was inspected without relying on old exemptions.
- Changed source and test files are below 500 lines. Whitespace and retained-evidence privacy checks
  passed. Temporary raw logs stay outside tracked/distributed inputs and are removed at delivery.

## Residual risk and activation

- Deadlines require a responsive JavaScript event loop. They do not cure a blocked native pool or
  a main-thread freeze. Timer lag and request counts help distinguish those conditions.
- An in-flight native operation cannot be forcibly cancelled here. Late owned files are cleaned
  after it settles; if it never settles or the process exits first, the existing reaper remains
  the cleanup fallback. An empty uploads directory may be created after a mkdir timeout.
- The callback probe is diagnostic, not a recovery retry or provider message replay. At most one
  unresolved probe exists per process.
- Source validation is complete. Activating this main-process repair requires a rebuilt installed
  application and restart. No running application, provider session, or installed bundle was
  stopped or replaced during this task.

Related plan: [Image upload stall](../../plans/recent-3-days/PLAN_82_image-upload-stall.md).
Prior evidence: [Config read latency](../history/REVIEW_261_session-config-read-latency.md) and
[worktree preparation waits](../recent-month/REVIEW_277_enter-worktree-preparation-timeout.md).
