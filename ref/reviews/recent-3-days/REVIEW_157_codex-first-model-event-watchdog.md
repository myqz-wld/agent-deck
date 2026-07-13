---
review_id: 157
reviewed_at: 2026-07-13
baseline_commit: 217d87d75c4043aadeab20dfd88e4bf65c559061
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused Codex adapter review covers only the machine-readable scope below."
---

# REVIEW_157_codex-first-model-event-watchdog: Codex accepted-turn recovery

## Scope and method

This review covers the Agent Deck half of an AI Review Assistant incident in
which Codex accepted a turn but emitted no model, tool, usage, provider-error,
or terminal event. The incident directly exercised AI Review Assistant, while
code inspection proved that Agent Deck had the same unbounded accepted-turn
window. Review used deterministic app-server clients, child-generation tests,
full repository validation, and a separate cross-repository race review.

```review-scope
ref/reviews/recent-3-days/INDEX.md
src/main/adapters/codex-cli/app-server/client-generation-recycle.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.test.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.ts
src/main/adapters/codex-cli/app-server/process-recycle.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/recycle-logging.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/app-server/turn-watchdog-diagnostics.test.ts
src/main/adapters/codex-cli/app-server/turn-watchdog-diagnostics.ts
```

## Root-cause boundary

The provider-side cause remains unobservable from local evidence: the stalled
turn lies after app-server acceptance and before the first model-derived event,
but the trace cannot distinguish an app-server per-turn state-machine hang from
an upstream dispatch or stream loss. Agent Deck's actionable software defect was
definite: it had no bounded accepted-turn/first-model-event phase and therefore
could wait indefinitely for a provider boundary that might never arrive.
Review also found two local acceptance races that were independent of the
unobservable provider-side cause: notification-first acceptance was initially
tied to the later RPC continuation, and response plus model output delivered in
one stdout batch could outrun that continuation.

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | An accepted turn with no model-derived event had no phase deadline. | Added a 90-second first-model-event watchdog; lifecycle/config/user-echo events do not satisfy it. Timeout interrupts best-effort, retires the owned process generation, rejects pending RPCs, and never replays input. |
| HIGH | The first implementation armed only after the `turn/start` response, so `turn/started` followed by a hanging response still bypassed the deadline. | The first current-turn `turn/started` notification or matching response now establishes one latched acceptance boundary. A later response updates pending state but cannot reset the absolute deadline. |
| HIGH | A `turn/start` response and following model or terminal line can be emitted in one stdout callback before the response Promise continuation commits acceptance, causing a working turn to arm and later false-timeout. | Buffer only bounded turn-id flags and diagnostic metadata before acceptance, reconcile the exact response turn before arming, and consume same-batch model or terminal activity first. No protocol payload is retained. |
| MEDIUM | Agent Deck pools one app-server client across concurrent oneshot threads, so an unscoped or malformed event could incorrectly claim or disarm another thread's watchdog. | Only matching `turnId`, or matching `threadId` under the one-active-turn-per-thread invariant, can count as model activity. Notification-first acceptance additionally requires the exact requested `threadId` and a valid turn id; missing or mismatched scope falls back to the RPC response. |
| LOW | Existing logs could not reconstruct acceptance source, response-pending state, last scoped event age, pending RPCs, or recycle ownership without exposing raw protocol streams. | Added allowlisted snapshots: normal milestones at `info`, one timeout/recycle initiation at `warn`, expected stale fences and sanitized stderr activity at `debug`, and only real detach/signal failures at `error`. Persistent `info`/`warn`/`error` events contain stderr byte metadata only, and pre-acceptance counters merge only for the accepted turn. |
| LOW | Debug-only stderr sanitization is heuristic and can retain short sensitive text without a recognized key, URL, path, or entropy marker. | Residual. Treat `debug` output as sensitive. The default operational `info`/`warn`/`error` chain never includes stderr text and needs no debug protocol trace for stall classification. |
| LOW | A protocol-invalid sequence that produces model activity and a full terminal event but permanently omits the `turn/start` response can leave that RPC pending until recycle or dispose. | Residual. The current Codex protocol requires the response; terminal output still reaches the caller. Revisit if a real trace violates that requirement. |
| LOW | Recycling one shared process generation terminates other active turns on that generation. | Accepted tradeoff. A silent child cannot be trusted for selective recovery; all affected turns receive one process-wide terminal error, and none is automatically replayed. |

## Fixes landed

- Added explicit model-activity classification and a production 90-second
  accepted-turn watchdog.
- Added child-identity and process-generation fencing, synchronous pending-RPC
  rejection, MCP/init reset, `SIGTERM` plus one-second `SIGKILL`, and stale
  stdout/exit isolation.
- Preserved per-session serialized turns, shared oneshot concurrency, and the
  existing no-automatic-replay boundary.
- Reconciled response-first model/terminal lines before watchdog arming, bounded
  pre-acceptance state to eight turn ids without payloads, and made malformed
  `turn/started` notifications fail closed to response acceptance.
- Added bounded acceptance/deadline/event/process snapshots with generation,
  PID, pending-RPC, interrupt, and signal outcomes. Raw stderr/stdout, prompts,
  tool arguments, payloads, environment values, paths, URLs, credentials, and
  quoted/high-entropy values are omitted or redacted.
- Removed raw stdout-parse content and restricted persistent operational logs to
  byte counts and allowlisted metadata. Debug stderr keeps a best-effort
  sanitized tail and remains sensitive diagnostic output.
- Added notification-first, response-fallback, no-deadline-reset, scoped
  activity, terminal authority, pending rejection, process reaping, and stale
  generation regressions.

## Validation evidence

- `bash scripts/file-level-review-expiry.sh` completed before this record.
- Focused Codex adapter validation passed 38 files and 286 tests.
- Full `pnpm test` passed 285 files and 2,671 tests; one credentialed live smoke
  remained explicitly skipped.
- `pnpm typecheck` and `pnpm build` passed; the build transformed 423 main,
  9 preload, and 1,745 renderer modules.
- `git diff --check` and the advisory record hook passed. All ten changed
  first-party source/test files remain below 500 lines.

## Residual risk and follow-up

- Provider telemetry is still required to separate the upstream hang variants;
  the watchdog is recovery and containment, not a claim about provider internals.
- Debug stderr sanitization is not a confidentiality boundary. Keep `debug`
  output private; use the payload-free `info`/`warn`/`error` chain for routine
  incident capture.
- Default persisted logs are at
  `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log`. The new `info`/`warn` chain
  is available without enabling payload-bearing protocol traces.
- The running Agent Deck host was not restarted from inside its own active SDK
  session. Restart the application before expecting the current binary to use
  this source change.
