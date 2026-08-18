---
review_id: 245
reviewed_at: 2026-08-13
baseline_commit: c2a0a1ea4077d67fcfc1ea242d7caae7600b0222
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_245_remote-asset-relay-flow-control: Remote asset Relay flow control

## Scope and method

This review correlated the current packaged application's Remote SSH failure with the Relay
client/Worker byte-credit protocol, reproduced the initial-window boundary in memory, inspected the
August 11–13 application logs, and reviewed the registry and logger paths that amplified one
transport episode into repeated warnings and expected IPC error stacks.

```review-scope
src/clients/relay/stream-client.test.ts
src/hosts/electron/registry-resilience.test.ts
src/hosts/electron/registry-snapshots.ts
src/hosts/electron/registry.ts
src/hosts/local-worker/frame-bridge-chunking.ts
src/hosts/local-worker/frame-bridge.test.ts
src/hosts/local-worker/frame-bridge.ts
src/main/remote-host/service.ts
src/main/remote-host/transport-diagnostics.test.ts
src/main/remote-host/transport-diagnostics.ts
src/main/utils/__tests__/logger.test.ts
src/main/utils/logger.ts
```

## Findings

### HIGH — A Core output larger than the initial Relay credit could make no progress

The Worker bridge treated each Core output callback as one indivisible Relay payload. When an asset
catalog response exceeded the 256 KiB initial output credit, the bridge queued the whole payload.
The client returns credit only after receiving data, so neither side could advance that stream.
The fix bounds Worker output data frames at 64 KiB and validates the exact encoded route-frame
capacity, allowing the initial window to carry several chunks and subsequent credit frames to drain
the remainder.

### MEDIUM — Equivalent SSH states were republished as new host state

Reconnect attempt counters are transport-local and are not represented in `ElectronHostState`, but
each attempt still republished an otherwise identical state. That needlessly re-ran consumers,
advanced request-scope ownership, and multiplied the same transport warning. The registry now
publishes only a semantic state change, including exact capabilities and public error fields.

### LOW — One transport episode produced an unbounded warning storm

The Remote service logged every registry callback, including identical failures and intentional
shutdown states. Diagnostics now record the first failure and meaningful failure transitions,
summarize continuing episodes at most once every five minutes, report recovery once, cap retained
profile/count state, and silently clear expected stop reasons.

### LOW — Expected stale-scope cancellation stacks obscured the causal failure

Electron records rejected IPC handlers with a full error stack. `stale_scope` is expected after a
Remote authority switch or reconnect and was dominating the error stream after the transport
failure. A narrow file-transport filter now requires both a `remote-host:*` Electron handler prefix
and an exact `RemoteHostPublicError`/`stale_scope` pair. Development-console visibility and every
other error remain unchanged.

## Validation and evidence

- In the active packaged run, one episode emitted 36 identical Remote transport warnings and 16
  persisted `stale_scope` stacks. Across August 11–13, 398 of 482 warning headlines were the same
  Remote transport message.
- A read-only scan probe took 128–152 ms plus 47–52 ms for digest/catalog work, ruling out a slow
  filesystem scan as the primary failure.
- Rebuilding the catalog against the active Worker's exact `providerHomeRoot` and installed resources
  produced 373 assets: the DTO was 271,240 bytes and the complete Core result frame was 271,323
  bytes, 9,179 bytes above the 262,144-byte initial output credit.
- The full Relay client → router → Worker integration round-tripped a byte-exact 280 KiB response,
  returned credit, and ended with zero queued Worker output bytes.
- Focused final validation: 5 files and 65 tests passed.
- Full suite: 961 files passed, 2 skipped; 6,148 tests passed, 3 skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm build:linux-headless`,
  `pnpm check:deployment`, and `pnpm logger:check`: passed.
- `pnpm verify:linux-headless` completed its build but stopped at the pre-existing
  `src/hosts/server-core/mcp-server.test.ts` 504-line size-gate violation. The file is unchanged from
  the baseline and is outside this fix.
- No running application or remote service process was killed, restarted, installed, or deployed.

## Fixes landed

- Fragment large Worker-to-client Core output into credit-sized, route-valid chunks.
- Cover the exact above-initial-credit path at both the Worker bridge and full Relay integration
  boundaries.
- Deduplicate semantically unchanged host-state publications.
- Replace per-callback transport warnings with bounded episode diagnostics and recovery summaries.
- Drop only expected Remote stale-scope IPC stacks from persisted logs.

## Residual risk

- A single synchronous Core output larger than the initial credit plus the bounded per-stream queue
  still receives a `backpressure` reset by design. Current asset catalogs remain below that bound.
- The installed application and the currently attached Remote Worker retain the old behavior until
  a new package is installed and the Worker is refreshed. Deployment was deliberately not performed
  because verification did not require disrupting the running application.
- The unrelated baseline 504-line test file continues to block the aggregate Linux headless gate.

## Follow-ups

- Package/install this build and refresh the managed Remote Worker when a disruptive rollout window
  is available.
- Repair the pre-existing `mcp-server.test.ts` size-gate violation as a separate maintenance change.
