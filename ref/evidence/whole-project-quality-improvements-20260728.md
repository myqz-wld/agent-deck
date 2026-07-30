# Whole-project quality improvement implementation plan

> Archived execution evidence captured during the 2026-07-28 refresh. This file preserves the
> original batch map, benchmark gates, and architecture decision history; it is not the current
> execution status. See
> [`PLAN_23_whole-project-quality-refresh.md`](../plans/recent-3-days/PLAN_23_whole-project-quality-refresh.md)
> for the authoritative completed plan and residual actions.

Status: refreshed; revised implementation and prompt-asset scopes await user confirmation
Original implementation approval: 2026-07-27
Original baseline: `main@c48aae5f6f1f3a22c89f6bbb50366848042392eb`
Refresh head: `main@a63033bdeeecdf3aba0d6d31a5818e5dc41c679a`
Refresh date: 2026-07-28
Workspace: `/Users/wanglidong/Repository/agent-deck`

## Goal

Improve Agent Deck's overall code quality through a staged set of correctness, security,
performance, lifecycle, architecture, interaction, copy, prompt-contract, and observability
changes discovered during the preliminary exploration and the 2026-07-28 all-code refresh.

The implementation must prioritize source-backed correctness and ownership-boundary defects before
speculative performance work. It must preserve existing product policy and documented design
tradeoffs unless a measured regression justifies changing them.

## 2026-07-28 refresh record

- Three parallel read-only audits covered the complete current implementation in their assigned
  domains, not only the eight commits after the original baseline:
  - adapter/runtime/MCP/prompt-contract code across `src/main/adapters/`, `src/main/session/`,
    `src/main/agent-deck-mcp/`, `src/shared/`, and all bundled Claude Code, Codex CLI, and Grok
    Build assets;
  - all renderer `input`/`textarea` call sites and related content viewers, shared/preload
    payload contracts, user copy, and developer comments;
  - the logging stack, approximately 499 logger call sites, implicated lifecycle/runtime paths,
    and 4,372 log lines from 2026-07-20 through 2026-07-28, with full semantic review of the
    2026-07-27 and 2026-07-28 samples.
- The refresh started from a clean `main@a63033bd`; `git status --short` was empty. The refresh
  changed only this ignored `.ref` plan. No production implementation, test, build, staging,
  commit, or prompt-asset edit has occurred.
- `c48aae5f..a63033bd` is attribution evidence, not the audit boundary. A finding is called
  recently introduced or fixed only when the current source, tests, and commit ancestry support
  that conclusion. Because runtime logs do not yet carry build/run identity, log disappearance
  alone is not proof that a commit fixed a defect.
- The refresh keeps valid original findings, removes no benchmark gate, and extends phases where
  the new audits found a wider boundary or a previously omitted producer/consumer contract.

## User-priority traceability

1. Three-adapter terminology, shared behavior, and preserved differences: invariants,
   Architecture 3/6, Phase 4, and batches B6–B8/B19/B21.
2. User-facing copy and developer comments: invariants, Phase 3, and B14–B19.
3. One top-right expand interaction with image/attachment fidelity: Architecture 5, Phase 3,
   B5/B14–B18, and the Electron visual checks.
4. Shared code abstractions with adapter-specific permission/sandbox/create/handoff behavior:
   Architecture 2/3, Phases 2/4, and B2/B3/B6/B7.
5. User/developer/LLM audience separation and explicit LLM schema/logic: invariants,
   Architecture 6, the prompt-asset scope, and B21.
6. Recent application-log defects and logging quality: the refresh evidence, Phases 1/5/7, and
   B4/B9/B10/B13/B20.
7. Spawn batching description and large-task delegation in each adapter system prompt: the exact
   prompt-asset candidate list and B21, gated behind the corresponding production semantics.

## Invariants

- A committed handoff must never allow new work to execute on the predecessor.
- Durable message state must identify the same logical sender and receiver that actually accepted
  the delivery.
- One session must not expose, send, mutate, or dispose another session's drafts, browser state,
  hook events, review gates, or runtime controls.
- Browser `file://` navigation remains a supported product capability. The fix is to authenticate
  who acquires Browser capability, not to remove the capability.
- Claude Code, Codex CLI, and Grok Build must share equivalent ingress, handoff, recovery,
  runtime-persistence, collaboration, and user-facing semantics where their provider protocols
  allow it. Provider-specific mechanics remain explicit behind the shared contract.
- Product prose uses the canonical names **Claude Code**, **Codex CLI**, and **Grok Build**.
  Protocol identifiers such as `claude-code`, `codex-cli`, `grok-build`, enum values, method
  names, config keys, and model/provider values remain unchanged.
- Every string and content contract must be classified by audience. User-facing copy follows
  `UI_COPY_LANGUAGE.md`; developer comments explain current non-obvious invariants rather than
  review archaeology; LLM-facing assets state executable contracts rather than UI or engineering
  implementation trivia.
- An LLM-facing tool or system contract must expose its input/output schema, field constraints,
  ownership, preconditions, side effects, timeout and retry behavior, errors, success invariants,
  and exact next action. It must not require the LLM to infer hidden engineering logic.
- Content that meets the documented expansion criterion uses one top-right expand action to open a
  dedicated page or panel. The expanded view receives the typed payload and preserves text,
  images, attachments, diffs, annotations, metadata, and authorization context; it must not
  silently degrade to a text-only copy.
- Do not retain meaningless duplicate prose, obsolete compatibility code, generic fallbacks, or
  defensive branches without a current supported-version, recovery, or safety contract.
- Main-process synchronous work must have an explicit row, byte, time, or concurrency bound.
- Large database migrations must be classified and recoverable; a migration documented as offline
  must not silently run as a normal main-thread startup migration.
- Existing FIFO/fairness behavior for teammate messages must not change without an explicit
  decision and behavioral tests.
- Existing issue event/list race protection must not be replaced by a cache eviction policy that
  can reintroduce stale-response deletion.
- Every schema change uses the next migration and advances `user_version`.
- Do not edit durable AI prompt assets unless the prompt-asset workflow is invoked and the
  Claude Code/Codex CLI counterparts are reviewed together.

## Confirmed scope and decisions

### Implement as current work

1. Browser pipe capability authentication, canonical ownership, and bounded transport.
2. Session-scoped hook capabilities.
3. Handoff/message delivery consistency and adapter ingress parity.
4. Plan/diff review gate transfer semantics.
5. Renderer logical-session state isolation and heavy-row lazy rendering.
6. Codex CLI resume/turn attribution/process retirement hardening.
7. Claude Code plugin mirror atomicity and retry behavior.
8. Grok Build runtime-option reset/persistence atomicity.
9. Offline/staged migration execution contracts, starting with V43.
10. Bounded file-change reads and targeted snapshot access.
11. Lifecycle/shutdown/purge batching and ownership safety.
12. Small source-backed correctness fixes such as issue append atomicity and team close-time
    semantics.
13. Targeted cache/query/IPC improvements whose semantics can be preserved.
14. Regression tests, benchmarks, observability, and durable final records.
15. A unified expandable-content interaction and typed payload fidelity across authoring,
    pending, activity, team, task, Issue, plan/diff review, permission, asset, and diagnostic
    surfaces.
16. Canonical adapter display names, natural zh-CN user copy, current-invariant developer
    comments, and explicit LLM contracts.
17. Full Codex CLI control-plane deadlines; transactional Grok Build runtime mutations; atomic
    Claude Code plugin mirrors; and honest collaboration/runtime outcomes.
18. `spawn_session` team and reply-anchor success invariants, complete output/error contracts, and
    reasonable non-overlapping child-session batch guidance.
19. Shutdown ingress/DB-close ordering, build/run log identity, bounded diagnostic redaction,
    Hook failure observability, Logs IPC/UI hardening, and state-transition/rate-limited logging.
20. Async, bounded, cancellable creation-default config reads with observable resolution sources.
21. Grok Build reviewer data-exfiltration safety parity with Claude Code and Codex CLI.
22. Prompt-asset changes only through the exact separately confirmed scope and gates recorded
    below.

### Preserve or treat as benchmark-gated

- `file://` is explicitly supported and is not independently a bug.
- Screenshot age-only retention is an already-recorded feature gap. Implement quota work only
  against its existing Browser plan/follow-up; do not create a duplicate finding.
- Token daily aggregation measured about 0.10 seconds on a production-sized 116,000-row ledger.
  Add a repeatable benchmark and refresh coalescing first. Do not add a persistent rollup unless
  larger fixtures cross the agreed latency budget.
- Teammate-message temporary sorting is an acknowledged FIFO/fairness tradeoff. Require current
  `EXPLAIN` and backlog benchmarks before changing its schema or query.
- The Issues keep-all map protects newer event records from stale list responses. Any optimization
  must separate authoritative entities from bounded query membership; do not simply evict from the
  current map.
- The same-millisecond Issue version race already has a recorded follow-up. Reuse that record and
  avoid duplicate tracking; a monotonic revision is still the preferred architectural remedy.
- Cross-target Grok Build packaging preflight depends on the real CI matrix. Native target builds
  should be asserted explicitly; only add cross-target verification if cross-build artifacts are
  supported.

## Architecture direction

### 1. Session capability and ownership model

- Mint an unpredictable capability for each live session-facing Browser pipe and hook endpoint.
- Bind capabilities to a registered live session and process/connection lifetime.
- Use a canonical Agent Deck session owner abstraction for MCP Browser and Codex CLI pipe Browser
  fronts, or maintain an explicit session-to-owner registry that disposes every front atomically.
- Give each Browser connection a lease/reference so one connection cannot destroy another
  connection's owner.
- Treat caller-provided session IDs, origins, and PIDs as metadata rather than authority.

### 2. Handoff and delivery protocol

- Add a delivery generation/lease to claimed messages.
- Retarget only `pending` envelopes. A `delivering` envelope must be drained, cancelled through an
  explicit protocol, or completed against its original generation.
- Make delivery completion a compare-and-set over message ID, status, destination, and generation.
- Stop new claims before handoff/shutdown drains in-flight work.
- Factor one shared adapter ingress guard used by both `sendMessage` and `enqueueMessage`.
- Model plan and diff gates as transferable successor work, not as source promises whose session ID
  is mutated in place.

### 3. Adapter lifecycle and runtime-control layer

- Centralize generation-aware provider request deadlines, abort/recycle, process retirement,
  pending request rejection, and readiness-cache invalidation.
- For Codex CLI, bound the complete control-plane chain: initialize, `config/read`, option
  preparation, thread start/resume/fork, and caller-visible readiness. An outer timeout must not
  leave the app-server loop blocked or report false success.
- Filter provider notifications by accepted turn identity rather than thread identity alone.
- Reuse a transactional runtime-option controller: provider mutation, durable persistence, and
  rollback/reset have one defined contract.
- Route Grok Build model/thinking/mode mutation and explicit null/native-default reset through that
  contract; handle old-process stop failure and target/rollback stop failure without leaving a
  half-closed runtime.
- Install Claude Code plugin mirrors through a complete sibling staging tree and atomic swap;
  cache only success, omit the plugin path on failure, and retry on the next eligible session.
- Preserve adapter-specific protocol behavior behind this shared lifecycle boundary.

### 4. Storage execution model

- Classify migrations as `online`, `offline`, or `staged`.
- Normal startup must fail fast with actionable instructions before touching an offline migration.
- Staged maintenance is resumable, has bounded slices, and records progress/recovery state.
- Separate paged metadata queries from on-demand large payload/snapshot retrieval.
- Apply bounded catch-up loops with short transactions to lifecycle and retention work.

### 5. Renderer state model

- Key draft, attachment, pending request, and async completion state by logical session identity.
- Handle temporary-to-persisted session ID migration explicitly.
- Prevent stale async completions from mutating the newly selected session by using a generation or
  abort signal.
- Pass per-row scalar state to memoized feed rows; mount Monaco or other heavy renderers only on
  explicit expansion.
- Use one top-right expansion affordance for content above the expansion criterion. Open a
  dedicated page/panel keyed by logical session plus request/event/message identity, restore
  focus on close, and bound simultaneously mounted heavy views.
- Preserve typed content end to end. Renderer-safe attachment descriptors may authorize bounded
  preview reads, but full base64 data or arbitrary filesystem paths must not enter general React
  state.
- Separate authoritative entity versions from query/list membership for long-lived stores.

### 6. Collaboration, audience, and prompt-contract model

- Treat requested collaboration scaffolding as part of `spawn_session` success: a requested
  `teamName` requires a durable non-null team, and a reply-chain workflow requires a durable
  non-null anchor. Do not silently return a standalone or unreplyable child.
- For broad work, split by independently executable outcome and non-overlapping write set. Keep
  tightly coupled producers and consumers in one batch, give every child a self-contained scope
  and validation contract, and run only independent batches in parallel within `spawnLimits`.
- Use adapter runtime profile display names as the product-label SSOT. UI and user-facing errors
  may add a mechanic suffix such as `Codex CLI app-server` or `Grok Build ACP`; they must not
  invent short product names.
- Keep user, developer, and LLM information dense and audience-appropriate. Remove plan/review
  numbers and obsolete alternatives from source comments while retaining current security,
  lifecycle, authorization, focus/Escape, image-fidelity, and stale-owner invariants.

### 7. Observability and diagnostic model

- Emit one bounded startup identity per process with a run identifier, PID, app version, short
  build commit, build time/dirty state when available, packaged state, platform/architecture,
  schema version, and log level. Do not record home paths, cwd, credentials, prompts, or payloads.
- Log state transitions and outcomes rather than repeated success chatter. Rate-limit repeated
  signatures and report suppressed counts; retain correlation IDs, phase, duration, and recovery
  outcome.
- Sanitize and bound external diagnostic strings before logging, then apply a last-resort file
  transport redaction. Hook failures must be observable without logging request bodies,
  prompts, tool input, or secrets.

## Implementation phases

### Phase 0 — Reproduction, baselines, and safety rails

- [ ] Enter an isolated worktree from local `main`; use a dedicated work branch.
- [ ] Re-read repository instructions in the worktree and inventory overlapping user changes.
- [ ] Run the baseline validation suite and record timings.
- [ ] Add deterministic failing tests for:
  - arbitrary Browser pipe session assertion;
  - duplicate connections claiming/discarding one Browser owner;
  - a handoff retargeting an envelope while adapter delivery is pending;
  - Grok Build `enqueueMessage` during an acquired cutover lease;
  - plan and diff gates transferred during UI handoff;
  - Composer draft/image state across session A to B and a pending outgoing message whose full
    attachment descriptors must remain inspectable;
  - typed expansion of message attachments, image diffs, `ImageRead`, plan/diff annotations, and
    Team event payloads without cross-session leakage;
  - Codex CLI initialize, `config/read`, and thread start/resume requests that never settle;
  - Grok Build old-process stop, target persistence, rollback persistence, and rollback stop
    failures;
  - Claude Code plugin mirror copy/substitution failure and a concurrent reader;
  - requested `spawn_session` team creation or reply-anchor persistence failure;
  - Hook translation/emission failure returning 500 without exposing the request body;
  - token-usage polling while shutdown closes the database;
  - startup/run identity and bounded diagnostic redaction;
  - watcher shutdown while delivery is pending;
  - normal startup encountering V43 as a pending offline migration.
- [ ] Capture performance baselines for file-change reads, settled permission rows, token daily
  aggregation, message dispatch backlog, lifecycle catch-up, and permission scanning.

Acceptance: each high-priority defect has a deterministic regression test or a documented
reproduction harness before its implementation change.

### Phase 1 — Browser and hook security boundary

Primary files:

- `src/main/browser-use/server.ts`
- `src/main/browser-use/protocol.ts`
- `src/main/browser-use/fronts/codex-pipe.ts`
- `src/main/browser-use/session-browser.ts`
- `src/main/browser-use/engine/registry.ts`
- `src/main/hook-server/`
- adapter hook installers/routes

Work:

- [ ] Replace self-asserted pipe session binding with a per-session unpredictable capability.
- [ ] Validate the capability against a live registered runtime and revoke it on close/handoff.
- [ ] Canonicalize or comprehensively map Browser owner namespaces.
- [ ] Add connection leases/ref-counted disposal.
- [ ] Replace repeated frame `Buffer.concat` with a bounded chunk/ring decoder.
- [ ] Bound requests in flight, input bytes, output bytes, and slow-reader buffering.
- [ ] Mint adapter/session-scoped hook capabilities and validate the body session against them.
- [ ] Fail closed or abort startup when the canonical Hook token is unavailable; do not accept an
  unauthenticated request through an empty-token defense branch.
- [ ] Log rate-limited Hook route failures with adapter, event, origin, short session identifier,
  phase, and safe error category. Keep provider Hooks non-blocking when policy requires it, but
  never make translator/emitter/DB failures invisible.
- [ ] Keep `file://`, `http://`, `https://`, and documented Browser behavior unchanged.
- [ ] If included under the existing Browser plan, add screenshot count/byte quotas with oldest
  eviction and concurrency-safe accounting.

Acceptance: an arbitrary same-UID process cannot acquire another Agent Deck session's Browser or
hook authority; one connection cannot dispose another's tabs; transport memory and concurrency are
bounded; every Hook 400/500 path has a safe, correlated, rate-limited diagnostic without logging
the payload.

### Phase 2 — Handoff, message delivery, and review gates

Primary files:

- `src/main/teams/universal-message-watcher/`
- `src/main/store/agent-deck-message-repo/`
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session/`
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts`
- `src/main/agent-deck-mcp/tools/handlers/spawn-team.ts`
- `src/main/agent-deck-mcp/tools/handlers/spawn-prompt.ts`
- `src/main/session/hand-off/`
- `src/main/plan-review/`
- `src/main/diff-review/`
- adapter message controllers/bridges

Work:

- [ ] Add delivery generation/lease fields and compare-and-set completion.
- [ ] Stop retargeting `delivering` rows; define drain/cancel behavior at cutover.
- [ ] Make watcher stop asynchronous: stop new claims, await the active delivery within the
  application quit budget, then close adapters/database.
- [ ] Move Grok Build send/enqueue through the same handoff ingress guard as Claude Code and
  Codex CLI.
- [ ] Run the first source-ownership check immediately after successor creation and before queued
  message delivery.
- [ ] Convert active plan gates to successor-delivered decisions during handoff.
- [ ] Implement matching diff-gate rehome semantics or explicitly block handoff until the diff is
  resolved; prefer rehome for parity.
- [ ] Treat requested spawn collaboration setup as an atomic precondition/result contract:
  - fail before provider creation when a requested team cannot be created or inspected;
  - return success with `teamName` only when the durable `teamId` is non-null;
  - persist the initial reply anchor before exposing an instruction that requires it;
  - if anchor persistence fails after provider creation, close/roll back the child or complete a
    separately approved durable repair protocol; never return dishonest success.
- [ ] Remove, hide, or explicitly deprecate any LLM-visible spawn field with no current runtime
  semantics, including `parentSessionId` unless a real caller contract is implemented.
- [ ] Test rollback, commit, shutdown, retry, and adapter failure interleavings.

Acceptance: every interleaving produces exactly one logical executor and one durable terminal
message state; successor review decisions resume the successor exactly once; a successful spawn
satisfies every requested team and reply-chain invariant and exposes no partial-success ambiguity.

### Phase 3 — Renderer session isolation and bounded rendering

Primary files:

- `src/renderer/components/SessionDetail/ComposerSdk.tsx`
- `src/renderer/components/SessionDetail/`
- `src/renderer/components/NewSessionDialog.tsx`
- `src/renderer/components/HandOffPreviewDialog.tsx`
- `src/renderer/components/IssueDetail.tsx`
- `src/renderer/components/ResolveInNewSessionDialog.tsx`
- `src/renderer/components/pending-rows/`
- `src/renderer/components/activity-feed/`
- `src/renderer/components/TeamDetail/`
- `src/renderer/components/settings/`
- `src/main/ipc/adapters-outgoing.ts`
- `src/shared/types/agent.ts`
- `src/renderer/stores/`

Work:

- [ ] Store composer text, attachments, errors, and request generation by logical session.
- [ ] Define temporary-to-real session ID draft migration without cross-session leakage.
- [ ] Ignore/abort stale completion callbacks after selection changes.
- [ ] Add a synchronous create-session in-flight lock and explicit close-during-create behavior.
- [ ] Catch permission/question/batch response failures and render local actionable errors.
- [ ] Key Ask drafts by request-local index or stable ID, not question text.
- [ ] Lazily mount settled permission Monaco diffs; bound simultaneously expanded heavy views.
- [ ] Pass scalar per-row derived props so `ActivityRow` memoization remains effective.
- [ ] Filter TeamDetail invalidations by the event's `teamId` and sequence/coalesce refetches.
- [ ] Bound/dedupe live summaries to repository retention.
- [ ] Add one shared expandable-content shell with a top-right expand action, dedicated page/panel,
  focus restoration, nested Escape handling, dirty-close hooks, stable payload keys, and typed
  rendering slots. Apply it when any condition is true:
  - multiline content can exceed roughly six visible lines or 600 characters;
  - the payload is structured content such as a plan, diff, tool input/result, log, prompt asset,
    Issue evidence, task, or event;
  - the payload contains an image or attachment;
  - the compact surface truncates content and no existing navigation reaches the full value.
  Search, paths, model/profile identifiers, enums, numbers, checkboxes, and other atomic fields do
  not gain expansion merely because they are one-line controls.
- [ ] Preserve typed payload fidelity in expanded views:
  - message text, render mode, attachments, handoff/wire metadata;
  - `DiffPayload`, image authorization session, all panes, rationale, annotations, and
    instructions;
  - tool input/result/status/truncation and `ImageRead` source;
  - plan/review content, quotes, feedback, and surface-specific actions;
  - Team event/task fields, labels, and diagnostic entries.
- [ ] Extend the pending-outgoing IPC projection with renderer-safe opaque attachment descriptors
  and a bounded authorized preview path. Do not put full base64 content or arbitrary paths in
  React state.
- [ ] Use the existing Composer and DiffTab expanded views as behavioral references. Migrate
  inconsistent drag-only, inline-only, row-click, and inaccessible-title interactions without
  removing legitimate surface-specific approve, revise, save, delete, or external-open actions.
- [ ] Add full typed details for the currently lossy surfaces: pending outgoing attachments, Team
  events/tasks, session tasks, `ImageRead`, permission payloads, summarizer diagnostics, Issue
  appendix `logsRef`, and long authoring/review fields.
- [ ] Decide whether handoff expansion may retrieve the complete provider prompt through a
  controlled bounded/streamed IPC. If not, label the renderer projection as an excerpt and do not
  claim that expansion exposes the full target prompt.
- [ ] Normalize user-facing adapter names and natural Simplified Chinese copy without altering
  protocol identifiers. Replace review/plan/changelog archaeology in comments with concise current
  invariants; preserve image fidelity, authorization, focus/Escape, stale-owner, and session
  isolation rationale.

Acceptance: session A state is never visible or sendable in B; rejected row actions do not trigger
the global fatal overlay; every qualifying compact surface reaches one dedicated expanded view by
the same top-right action; expansion preserves its complete authorized typed payload including
images and attachments; heavy editor/viewer count, blob lifetime, and feed re-render count remain
bounded; keyboard, touch, narrow-window, focus, and nested-Escape behavior are verified.

### Phase 4 — Adapter recovery and runtime parity

Work:

- [ ] Give the complete Codex CLI control plane a generation-aware deadline and abort/recycle
  path: app-server initialize, `config/read`, option preparation, thread start/resume/fork, and
  caller-visible readiness. Clear rejected readiness/config caches, fence stale generations, reject
  all pending requests, and make a later retry succeed; do not report fallback creation success
  while retaining a blocked loop.
- [ ] Attribute queued notifications to the accepted turn ID and drop stale prior-turn packets.
- [ ] Ignore or fail closed on malformed terminal packets; never translate malformed completion to
  success.
- [ ] Reuse bounded child retirement for normal Codex CLI disposal.
- [ ] Install Claude Code plugin mirrors through a temporary sibling and atomic rename; cache only
  success and omit/retry on failure.
- [ ] Move Grok Build model/thinking/mode mutations into a shared transactional controller. Make
  null/native-default reset explicit, bound ACP requests, persist atomically, and roll back or
  dispose after provider/DB/stop failure. Old-process stop failure must restore a usable state or
  terminate it honestly, never leave `ready=false` with a detached process.
- [ ] Make Codex CLI approval/sandbox rollback results honest. When live or DB rollback fails,
  report the state as unknown/failed instead of sending an unconditional “rolled back” message.
- [ ] Use `runtime-profiles.displayName` as the shared user-facing label source for Claude Code,
  Codex CLI, and Grok Build while preserving adapter-specific mechanic suffixes and identifiers.
- [ ] Centralize adapter-aware CLI permission defaults in TypeScript and test wrapper parity.

Acceptance: every provider request has a bounded terminal path; late or malformed events cannot
produce cross-turn or false-success activity; runtime and durable configuration agree after both
success and injected failures; stop/rollback failures produce an explicit terminal state; canonical
display names do not change protocol values.

### Phase 5 — Storage, migration, and lifecycle correctness

Work:

- [ ] Introduce migration execution metadata and make `initDb()` reject/defer offline migrations.
- [ ] Route V43 through the offline tool or a resumable staged implementation; preserve validation
  and rollback source.
- [ ] Split file-change paged metadata from on-demand snapshot retrieval.
- [ ] Add targeted SQL for one-path final diff and image authorization without loading all
  snapshots.
- [ ] Exclude live SDK-owned sessions from retention purge or perform awaited close/release and a
  late-event resurrection blacklist before deletion.
- [ ] Stop or gate DB-backed renderer IPC ingress before `closeDb()`. Token-usage poll rejection
  during shutdown must resolve as an explicit unavailable/shutdown result or be caught locally,
  never hit closed prepared statements or the global renderer rejection overlay.
- [ ] Wrap lifecycle scheduler ticks in recoverable error isolation.
- [ ] Use `endedAt` as team close time, with a conservative legacy fallback.
- [ ] Chunk lifecycle catch-up and token retention deletes into short bounded transactions.
- [ ] Wrap issue appendix insertion and parent logs-ref update in one transaction.
- [ ] Reuse the existing Issue revision follow-up and introduce a monotonic revision if that work
  is taken in this phase.
- [ ] Add a second-stage maintenance-worker terminal policy only after documenting SQLite
  termination safety; do not blindly terminate a worker inside native I/O.
- [ ] Replace creation-default synchronous config scanning with async, bounded, cancellable reads.
  Cache by valid resolution boundary, invalidate on generation/cwd/provider change, expose a safe
  resolution-source/error category, and never log actual config contents or private paths.

Acceptance: startup performs no undocumented unbounded offline work; purge cannot resurrect a live
session without history; file-specific reads are proportional to the requested path; maintenance
failure does not terminate the app or wedge maintenance indefinitely; DB-backed IPC cannot enter
after database close; creation-default resolution cannot block the main loop or accumulate orphaned
provider requests.

### Phase 6 — Measured performance and data-model follow-ups

- [ ] Add a repeatable token aggregation benchmark for roughly 100k, 1m, and 5m rows.
- [ ] Coalesce renderer refreshes and cache by data revision/affected days.
- [ ] Add persistent daily rollups only if the agreed larger-cardinality latency budget is crossed.
- [ ] Capture `EXPLAIN` and latency for teammate dispatch under realistic backlog distributions.
- [ ] Preserve FIFO/fairness; change the query/index only when measurements justify it.
- [ ] Split Issues into authoritative entity storage and bounded query membership with selected,
  dirty, and newer event versions pinned.
- [ ] Add size/depth/output limits and canonical-path dedupe to permission settings scanning.
- [ ] Normalize task dependencies into indexed `task_edges` as a separate schema project if task
  cardinality and delete measurements justify the migration.
- [ ] Add bounded batches to any remaining lifecycle or cleanup scans found during implementation.

Acceptance: every performance change has before/after measurements, preserves documented
semantics, and includes an explicit bound.

### Phase 7 — Packaging, observability, and durable records

- [ ] Confirm the actual CI artifact matrix.
- [ ] If builds are native-only, encode and assert that contract.
- [ ] If cross-target builds are supported, make the Grok Build verifier accept and validate
  explicit target platform/architecture.
- [ ] Add diagnostics for handoff drain duration, message backlog/claim generation, Browser auth
  failures and backpressure, screenshot bytes, snapshot bytes inflated, lifecycle batch duration,
  renderer cache size, and mounted Monaco count where practical.
- [ ] Emit one startup/run identity and correlated shutdown phase outcomes. Read packaged
  `build-info.json` safely when available; distinguish missing metadata from a commit mismatch.
- [ ] Introduce a shared bounded safe-diagnostic helper and last-resort file redaction. Cover
  credential headers/query parameters, cookies/password/API keys, home/tmp paths, quoted and
  high-entropy values, prompt/input/payload fields, circular objects, nested `Error.cause`, stacks,
  and long strings.
- [ ] Harden Logs IPC/UI: avoid lstat-then-clear TOCTOU, preserve the original error when close
  also fails, catch invoke rejection locally, keep the 2 MiB UTF-8 tail bound explicit, and test
  symlink swaps.
- [ ] Convert high-volume success logs to debug or bounded periodic summaries. Log provider usage,
  watchdog recycle, checkpoint refresh, migrations, WAL checkpoints, event-loop delay, MCP startup,
  MCP HTTP, and summarizer outcomes on state transition or meaningful latency; include suppressed
  counts and separate per-operation thresholds.
- [ ] Add Hook, runtime-control, approval, and spawn outcome logs only after safe diagnostic
  contracts exist. Every log must state operation, phase, correlation identity, duration/outcome,
  and recovery without raw user/provider payloads.
- [ ] Update existing plans/issues instead of duplicating known gaps.
- [ ] Archive the completed plan, write changelog/review records, update bucket indexes, and remove
  or classify this `.ref` plan.

## Prompt-asset scope proposal

This section is a proposal, not edit authorization. No durable prompt/tool-description asset may be
edited until the user confirms this exact file-and-section list and the proposed behavior changes,
the prompt-asset inventory/custom-point/backup gates succeed, and the production semantics for
Codex CLI deadlines and spawn team/anchor results are settled. If implementation changes the
contract materially, present a revised list before editing.

### Candidate editable files and sections

1. `src/main/agent-deck-mcp/tools/index.ts`
   - `spawn_session` registration and description only.
   - Add reasonable non-overlapping batching guidance and the complete effective success/error,
     nullable-field, timeout, retry, side-effect, and next-action contract after the handler
     invariants are implemented.
   - Use canonical product names while preserving adapter enum literals.
2. `src/main/agent-deck-mcp/tools/schemas/spawn.ts`
   - Adapter, prompt, team, agent, and lineage field descriptions plus a real LLM-visible output
     schema.
   - Require one self-contained batch objective/scope/output. Remove the public
     `parentSessionId`, hide it, or mark it deprecated/no-op only if compatibility evidence
     requires retention.
3. `src/main/agent-deck-mcp/tools/schemas/target-runtime.ts`
   - Adapter ownership, cross-field constraints, null/default behavior, and canonical product
     names.
4. `resources/claude-config/CLAUDE.md`
   - `Teammate Collaboration`, `Lead Wait Boundary`, and the `spawn_session` session-tool paragraph
     only.
   - Add small independently executable subtasks, non-overlapping write sets, coupled-file
     boundaries, self-contained briefs, and parallel execution within `spawnLimits`; preserve
     Claude Code-specific browser, permission, Gateway, and wait mechanics.
5. `resources/codex-config/CODEX_AGENTS.md`
   - `Teammate Collaboration`, `Codex Wait Boundary`, and the `spawn_session` session-tool
     paragraph only.
   - Add the same delegation semantics while preserving Codex CLI app-server, approval, sandbox,
     official Browser plugin, and native-fork mechanics.
6. `resources/grok-config/GROK_AGENTS.md`
   - Collaboration/wait/session-tool paragraphs corresponding to the Claude Code and Codex CLI
     sections.
   - Add the same delegation semantics while preserving Grok Build ACP, `sessionMode`,
     `grokSandbox`, and tool-permission differences.
7. `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`,
   `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml`, and
   `resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md`
   - Product identity/metadata only across all three.
   - Additionally add to the Grok Build reviewer the same public-documentation-only network rule,
     no-transmission boundary for source/diffs/logs/secrets/local paths/customer data, and exact
     readable-worktree/cache next action already present for Claude Code and Codex CLI.
8. `resources/claude-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md`,
   `resources/codex-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md`, and
   `resources/grok-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md`
   - Canonical product naming in adapter-specific self-check wording only; do not alter the fixed
     readiness response or trigger behavior.
9. `src/main/codex-config/__tests__/bundled-reviewer-runtime.test.ts`
   - Prompt-contract validation paired with the reviewer assets: include Grok Build in the same
     evidence/network-safety assertions and retain adapter-specific tool differences.

### Counterpart-check-only files and sections

- All six
  `resources/{claude,codex,grok}-config/agent-deck-plugin/skills/{simple-review,deep-review}/SKILL.md`
  files: confirm their existing subsystem/decision batching contracts remain aligned and
  byte-equivalent where intended; do not duplicate the new general delegation paragraph.
- The batch/input/output sections of all three reviewer assets: confirm exact-two-reviewer and
  scoped-output semantics remain intact; edit only the identity and Grok Build safety sections
  named above.
- `src/main/session/continuation-context/checkpoint-prompts.ts`: verify its ownership, untrusted
  evidence, schema, validator, and output constraints still align; no edit proposed.
- `src/main/session/oneshot-llm/build-prompt.ts` together with
  `src/main/session/summarizer/event-formatter.ts`: preserve the paired `[Claude …]` event marker
  contract unless a separate producer/consumer migration is approved.
- `src/main/agent-deck-mcp/tools/handlers/lead-context-block.ts`: recheck anchor wording after the
  spawn transaction is implemented; do not strengthen its promise in advance.
- The `hand_off_session` description in `src/main/agent-deck-mcp/tools/index.ts`: verify
  implementation truth and canonical names, but do not add parallel-decomposition guidance to a
  replacement-session tool.
- Browser, task, review-failure, worktree, issue, and safety sections in the three bundled
  baseline files: verify no semantic drift from adjacent edits; no behavior edit proposed.

### Explicitly excluded prompt assets and changes

- Root `AGENTS.md`, root `CLAUDE.md`, `README.md`, `resources/README.md`, and
  `UI_COPY_LANGUAGE.md`.
- Reviewer runtime permission/sandbox elevation, reviewer count/selection, review batching
  algorithms, output formats, and model-routing policy.
- `simple-review`/`deep-review` bodies, checkpoint prompt wording, oneshot event markers,
  handoff replacement semantics, Browser tool contracts, and unrelated MCP tool descriptions.
- User-authored application convention contents edited through the Claude Code/Codex CLI/Grok Build
  settings editors; only their UI chrome belongs to the renderer batch.
- Any promise of deadline, rollback, team, or reply-anchor behavior that production code and tests
  do not yet enforce.

### Required prompt-asset gates and validation

- Refresh `.prompt-asset-improver/local/inventory.json` for the confirmed root with a seven-day
  expiry, load custom points, classify editable versus check-only assets, and verify the local
  directory is ignored before writing records.
- Present path-and-section changes, representative high-risk wording, preserved adapter
  differences, and unchanged sections; wait for explicit user confirmation.
- Back up every confirmed editable asset under the timestamped manifest-backed local backup
  directory and verify original hashes before editing.
- Validate Markdown/resource links, frontmatter/TOML/TypeScript schema metadata, bundled paths,
  paired behavior, reviewer safety parity, tool success/error schema, and inventory hash refresh.

## Delivery structure

Use child sessions for implementation; the lead coordinates baselines, dependencies, integration,
and cross-batch validation. Before each dispatch wave, record the clean baseline and give every
child a self-contained objective, exact write set, expected output, focused validation, and stop
condition. A child must report a required scope expansion instead of touching an unlisted path.
Independent batches may run in parallel within `spawnLimits`; coupled producer/consumer contracts
stay in one batch.

### Wave 0 — shared baseline, decisions, and failing evidence

- Lead records typecheck/test/build timing and current dirty state.
- The owning implementation batch writes its own deterministic failing tests before the fix; do
  not create a separate test worker that overlaps every later write set.
- Confirm architecture-level decisions listed below, the revised plan, and the exact prompt-asset
  scope before dispatching affected batches.

### Wave 1 — independent correctness foundations

1. **B1 Browser capability and transport**
   - Depends on B4 before adding bounded Browser auth/backpressure diagnostics.
   - Exclusive write set: `src/main/browser-use/**` and its Browser-specific tests.
   - Includes owner/capability/lease/decoder/backpressure behavior and Browser diagnostics inside
     those files; excludes Hooks and renderer.
2. **B2 Handoff/message/review-gate state machine**
   - Depends on B4 before adding handoff drain/backlog diagnostics.
   - Exclusive write set: universal-message-watcher, message repository/migration, handoff
     handlers/services, plan-review/diff-review transfer code,
     `src/main/adapters/claude-code/sdk-bridge/message-controller.ts`,
     `src/main/adapters/codex-cli/sdk-bridge/message-controller.ts`, and their coupled tests.
   - Keeps schema migration, claim/retarget/complete CAS, ingress guard, gate transfer, and watcher
     drain in one batch. It owns diagnostics inside those paths and excludes
     `plan-review/deep-review-session.ts`, which belongs to B4. Grok Build consumes the shared
     ingress contract in B7 because B7 exclusively owns `grok-build/bridge.ts`; B2 acceptance is
     not complete until that dependent integration passes.
3. **B3 Spawn collaboration transaction**
   - Depends on B4 before adding safe spawn phase/outcome diagnostics.
   - Exclusive write set: `spawn.ts`, `spawn-team.ts`, `spawn-prompt.ts`, spawn collaboration tests,
     and only the cleanup helpers required by those handlers.
   - Owns diagnostics inside those paths. It excludes MCP tool descriptions/schemas, which belong
     to B21.
4. **B4 Logging identity and safe-diagnostic foundation**
   - Exclusive write set: `src/main/utils/logger.ts`, new logger/run-context/safe-diagnostic
     helpers, `src/main/index/bootstrap-infra.ts`, `renderer/main.tsx`,
     `plan-review/deep-review-session.ts`, and logger tests.
   - Must land before batches that add Hook/runtime/spawn diagnostics.
5. **B5 Expandable-content foundation**
   - Exclusive write set: new `src/renderer/components/expandable-content/**`, shared expansion
     icons only if absent, and foundation tests.
   - Defines payload union, portal/focus/Escape/dirty/stable-key/heavy-view contracts without
     migrating call sites. It owns the shared mounted-heavy-view bound and its instrumentation.
6. **B6 Codex CLI control-plane and runtime recovery**
   - Depends on B4 before adding safe deadline/recycle/approval outcome diagnostics.
   - Exclusive write set:
     `src/main/adapters/codex-cli/app-server/client.ts`,
     `src/main/adapters/codex-cli/app-server/thread.ts`,
     `src/main/adapters/codex-cli/app-server/node-repl-compat.ts`,
     `src/main/adapters/codex-cli/app-server/async-notification-queue.ts`,
     `src/main/adapters/codex-cli/app-server/notification-helpers.ts`,
     `src/main/adapters/codex-cli/sdk-bridge/resume-path-await.ts`,
     `src/main/adapters/codex-cli/sdk-bridge/session-retirement.ts`,
     `src/main/adapters/codex-cli/sdk-bridge/restart-controller.ts`, and their focused tests.
   - Covers initialize/config/thread deadlines, accepted-turn notification fencing, malformed
     terminal handling, normal child retirement, and honest approval/sandbox rollback outcomes.
     It owns related diagnostics and user-visible copy in those files so B19/B20 do not reopen
     them.
   - Excludes cross-adapter creation-default resolver files owned by B11.
7. **B7 Grok Build transactional runtime**
   - Depends on B2 for the shared handoff-ingress contract and on B4 before adding safe
     runtime/rollback outcome diagnostics.
   - Exclusive write set:
     `src/main/adapters/grok-build/bridge.ts`,
     `src/main/adapters/grok-build/runtime-start.ts`,
     `src/main/adapters/grok-build/runtime-factory.ts`,
     `src/main/adapters/grok-build/sandbox-restart-controller.ts`,
     `src/main/adapters/grok-build/__tests__/sandbox-restart-controller.test.ts`,
     Grok Build runtime-mutation tests, and
     `src/main/adapters/session-model-controller.ts` only if the confirmed design requires a
     generic extension.
   - Covers transactional model/thinking/mode changes, null/native-default mapping, bounded ACP
     calls, provider/DB rollback, old-process stop failure, target stop failure, rollback stop
     failure, and the Grok Build bridge's consumption of the shared handoff-ingress guard. It owns
     related diagnostics and all user-visible copy inside those files so B19/B20 do not reopen
     them.
8. **B8 Claude Code atomic plugin mirror**
   - Exclusive write set: Claude Code `sdk-injection.ts` and its tests.
9. **B9 Shutdown DB-ingress correctness**
   - Depends on B4 for correlated phase/outcome logging.
   - Exclusive write set: `src/main/index/lifecycle-hooks.ts`, `src/main/ipc/token-usage.ts`,
     `src/renderer/hooks/use-token-rates-poll.ts`, and their interleaving tests.
10. **B10 Logs IPC/UI hardening**
    - Exclusive write set: `src/main/ipc/logs.ts`, `LogsSection.tsx`, `LogViewerModal.tsx`, and
      their tests.
11. **B11 Async creation-default resolution**
    - Exclusive write set: `src/main/adapters/session-creation-defaults.ts`,
      `src/main/ipc/adapters-session-creation-defaults.ts`,
      `src/renderer/hooks/useSessionCreationOptions.ts`, `src/main/cli.ts`,
      `resources/bin/agent-deck`, `resources/bin/agent-deck.cmd`, and their resolver/CLI wrapper
      cancellation, bound, and parity tests.
    - Depends on the bounded Codex CLI primitive from B6 but does not edit B6 paths.
    - Centralizes adapter-aware CLI creation/permission defaults in TypeScript; wrappers transport
      normalized arguments and must not independently invent an adapter default.
12. **B12 Migration/storage/lifecycle correctness**
    - Exclusive write set: database initialization/migrations, file-change repository/query code,
      retention/lifecycle schedulers, Issue appendix transaction, maintenance worker, and coupled
      tests. This batch owns migration summary and WAL/storage-scheduler logging in
      `store/db.ts` and the storage scheduler, plus bounded lifecycle-batch duration/outcome
      diagnostics inside its owned paths.

### Wave 2 — parallel integrations after foundations

B14–B18 each own canonical user copy and current-invariant developer-comment cleanup inside their
exclusive files. B19 handles only untouched remainder paths after those batches complete.

13. **B13 Hook authority and failure observability**
    - Depends on B4.
    - Exclusive write set: `src/main/hook-server/**`, the three adapter hook routes/installers, and
      Hook contract tests. Combines authentication and safe 400/500 visibility because those files
      are strongly coupled.
14. **B14 Renderer session/payload contract and pending queue**
    - Depends on B5.
    - Exclusive write set: `src/renderer/components/SessionDetail/ComposerSdk.tsx`, its
      draft/attachment integration tests, `src/renderer/hooks/useImageAttachments.ts`,
      `src/renderer/stores/session-store*.ts`, pending-outgoing shared type, preload/IPC
      projection, authorized attachment preview path, `PendingOutgoingQueue.tsx`, and coupled
      main/renderer tests.
    - Owns logical-session draft/attachment/error/request-generation state, temporary-to-real ID
      migration, stale completion fencing, bounded/deduplicated live summaries, and renderer-cache
      diagnostics inside those paths.
15. **B15 Renderer authoring and handoff**
    - Depends on B5 and B14's shared attachment/session-state contract.
    - Exclusive write set: New Session, handoff preview/labels, Resolve-in-New-Session, and their
      tests. This batch owns the full-versus-bounded handoff preview decision and appendix
      `logsRef` serialization.
    - Owns the synchronous create-session lock, close-during-create behavior, and stale completion
      handling inside its dialogs.
    - This write set is complete only for the bounded-excerpt policy. If the user selects controlled
      full preview, stop before dispatch and revise B15 with an explicitly confirmed envelope for
      every coupled main/preload/shared preview path and test; do not infer or add those paths
      during implementation.
16. **B16 Renderer Issue/review forms**
    - Depends on B5.
    - Exclusive write set: Issue detail/editing, `PendingTab.tsx`, Permission/Ask/ExitPlan/
      DiffReview rows, plan deep-review dialog/footer/panels, diff-review presentation, and their
      tests.
    - Owns stable Ask draft identity, actionable local errors for per-row and batch responses, and
      lazy mounting/bounds for settled permission diffs.
    - Owns display of every Issue appendix `logsRef`; B15 separately owns serialization into the
      Resolve-in-New-Session prompt.
17. **B17 Renderer activity/team/task viewers**
    - Depends on B5 and on B14 only where queued attachment descriptors are rendered.
    - Exclusive write set: activity-feed `index.tsx`, message/thinking/tool rows and status,
      ImageThumb, TeamDetail `index.tsx` plus events/tasks/messages, SessionDetail tasks/messages,
      summarizer diagnostics, and their tests.
    - Owns scalar `ActivityRow` derivation/memoization and team-ID-scoped, sequenced/coalesced
      TeamDetail invalidation inside those paths.
18. **B18 Renderer asset/settings/permission viewers**
    - Depends on B5.
    - Exclusive write set: the three application-convention editor components, asset chrome,
      permission chrome/panels, and their tests. User-authored prompt contents are never rewritten.
19. **B19 Runtime display-name and remaining copy/comment cleanup**
    - Runs after B7 and B14–B18 so it does not overlap active workers.
    - Exclusive write set is frozen at dispatch to files untouched by those batches: runtime
      profile display-label consumers, Codex CLI permission titles, Grok Build user errors outside
      B7, Session list/footer, remaining settings copy, and source-comment tombstones. Provider
      usage files and logging call sites are excluded and belong to B20.
20. **B20 State-transition/noise logging**
    - Depends on B4.
    - Exclusive write set: provider-usage labels/logging, MCP startup observer/client, checkpoint
      refresh, event-loop monitor, summarizer logging, MCP HTTP transport, remaining logger call
      sites, and focused dedupe/recovery tests. `store/db.ts` and the storage scheduler are excluded
      and belong to B12. “Remaining” is frozen at dispatch and never reopens files owned by
      B1–B19.
21. **B21 Prompt/tool contract parity**
    - Depends on B3, B6, B7, B19, B20, explicit prompt-asset scope approval, inventory, and backup.
    - Exclusive write set is exactly the confirmed candidate list above. No other worker may touch
      those files during this batch.

### Wave 3 — benchmark-gated and final integration

22. **B22 Measured performance/data-model follow-ups**
    - Starts only after correctness batches are green and the documented benchmarks justify each
      mutation. Owns token aggregation experiments, dispatch query/index changes, Issues
      entity/query-membership separation, permission scan bounds, and any separately approved task
      edge migration.
23. **B23 Packaging, CI matrix, documentation, and records**
    - Starts after the supported artifact matrix is confirmed and all implementation batches pass.
    - Owns packaging assertions, README changes required by user-visible behavior, final
      changelog/review/plan records, bucket indexes, and `.ref` classification.

Do not combine these into one unreviewable commit. A batch may be split further only along
non-overlapping write sets with the revised envelopes confirmed before dispatch. Keep
behavior-preserving refactors separate from semantic fixes where doing so does not separate a
producer from its required consumer.

## Validation

For every implementation batch:

- `~/.local/bin/mise exec -- pnpm typecheck`
- focused Vitest files for changed behavior
- `~/.local/bin/mise exec -- pnpm test` for structural or cross-boundary changes
- `git diff --check`
- failure injection at every provider, database, persistence, stop, timeout, anchor, team, IPC, or
  filesystem boundary changed by the batch
- explicit evidence that files outside the approved write set did not change

Before final delivery:

- `~/.local/bin/mise exec -- pnpm build`
- logger/check scripts required by `CLAUDE.md`
- Electron Browser integration tests with real connection/disposal behavior
- handoff concurrency and failure-injection tests
- spawn team/anchor preflight, cleanup, rate-limit, fresh/fork, and partial-provider failure tests
- Codex CLI initialize/config/thread never-settle tests; Grok Build provider/DB/stop/rollback
  failure matrix; Claude Code plugin mirror concurrent-reader/failure/retry tests
- database-copy migration, interruption, disk-pressure, and recovery tests
- shutdown tests proving no DB-backed IPC begins after `closeDb()`
- logger tests for startup identity, safe diagnostics, credential/path/prompt fixtures, circular
  objects, long strings, state-transition suppression/recovery, and real `electron-log/node`
- renderer session-switch, typed-payload fidelity, focus/Escape, and bounded-editor/render-count
  tests
- Electron visual/interaction checks for:
  - New Session long text plus two images, expanded authoring, and nested image lightbox;
  - attachment-only pending messages, authorized preview, deletion, and session switching;
  - bounded/full handoff preview behavior and long next-step editing;
  - plan, diff, permission, tool input/result, `ImageRead`, and image-diff payloads;
  - Team event/task details, Issue appendix `logsRef`, and summarizer diagnostics;
  - all three application-convention editors;
  - keyboard Tab/Escape/focus restoration, touch target reachability, and narrow-window overflow.
- before/after fixed-scenario log counts proving that removed info/warn chatter did not remove
  failure, state-transition, recovery, duration, or correlation evidence
- prompt-asset inventory/backup manifest/original-hash checks, resource-path/frontmatter/TOML/schema
  validation, three-adapter behavior parity, and post-edit inventory hash refresh
- native packaging smoke checks for every supported CI target
- review-record expiry and `ref/` index checks

Use two heterogeneous deep-reviewer types after the Browser/handoff architecture batch, after the
storage/performance batch, and for final integration. Reviewer choice must be confirmed under the
deep-review workflow before spawning reviewers.

## Current checklist and progress

- [x] Five preliminary read-only exploration tracks completed.
- [x] Forty-four raw candidates were ranked, source-traced, and de-duplicated.
- [x] Known policies, existing follow-ups, and measured non-bottlenecks were separated from new
  findings.
- [x] Baseline `main@c48aae5f6f1f3a22c89f6bbb50366848042392eb` confirmed clean.
- [x] Baseline `~/.local/bin/mise exec -- pnpm typecheck` passed.
- [x] User approved the original 2026-07-27 plan for implementation.
- [x] Three 2026-07-28 parallel audits completed over all existing code in their assigned adapter,
  UI, and logging domains; recent commits were used only for attribution.
- [x] Audit findings were source-traced, deduplicated, and merged into this successor-ready plan.
- [x] Refresh head `main@a63033bdeeecdf3aba0d6d31a5818e5dc41c679a` and clean tracked worktree
  confirmed before this ignored plan edit.
- [x] Refreshed batch map and exact prompt-asset scope proposal completed.
- [ ] User confirmed the revised plan, architecture decisions, and implementation waves.
- [ ] User confirmed the exact prompt-asset editable/check-only/excluded scope and proposed changes.
- [ ] Isolated implementation worktree and branch created.
- [ ] Phase 0 regression tests and benchmarks committed.
- [ ] Phases 1-7 implemented and validated.
- [ ] Final heterogeneous review completed.
- [ ] Branch committed, pushed, and handed back for integration.

## First step for the successor

Read this file and all repository instructions, present the refreshed plan and exact prompt-asset
scope to the user, and resolve the architecture-level decisions below. After explicit approval,
create an isolated worktree from the named local `main` branch, record dispatch envelopes for the
first independent Wave 1 batches, and assign implementation to child sessions with the exact write
sets above. Before changing a schema or public IPC contract, inventory all callers and tests. Do
not start prompt edits before their separate gates, and do not begin benchmark-gated items until
the correctness/security batches are green.

## Risks and unresolved decisions

- Browser pipe capability delivery must not expose the token through a project-readable file or
  process argument. Prefer an inherited descriptor/environment channel whose visibility matches
  the provider process boundary.
- Killing a worker during synchronous SQLite/native I/O may be unsafe. A second-stage maintenance
  watchdog needs an explicit recovery design.
- Plan/diff gate rehome must define behavior when the source provider is still blocked and when the
  successor is not yet ready; exactly-once successor delivery is required.
- Message delivery generation changes the database state machine and requires migration,
  startup-reset, GC, handoff, and retry compatibility.
- Per-session composer persistence must decide whether switching away preserves drafts. The
  default is to preserve per-session drafts, never to carry them across sessions.
- Pending outgoing attachment projection must choose the minimum renderer-safe descriptor and
  authorization API. It must preserve file identity, name/MIME/size, and bounded preview capability
  without putting base64 or arbitrary paths in renderer state.
- Handoff preview must choose between an explicitly bounded excerpt and a controlled
  bounded/streamed full-provider-prompt read. The UI must not call an excerpt “complete.”
- Grok Build needs an explicit mapping for model/thinking/sessionMode null and native-default
  reset, including whether ACP requires a concrete model and what restart/rollback follows timeout.
- `spawn_session` needs a confirmed cleanup policy when team or durable anchor setup fails after
  provider creation: close and roll back immediately, or complete a separately designed durable
  repair transaction. Silent standalone/unreplyable success is prohibited.
- Decide whether the currently LLM-visible `parentSessionId` has a supported compatibility
  contract; otherwise remove or hide it rather than documenting a no-op as behavior.
- Logging identity must define the source and absence behavior for build metadata, run-ID lifetime,
  restart boundaries, and schema version. Redaction must define bounded string/stack sizes,
  credential/path/high-entropy patterns, console-versus-file policy, and false-positive tests.
- UI expansion must confirm whether “dedicated page” uses one shared routed page, a full-screen
  panel/overlay, or both behind one shell. The user-visible action and typed payload contract remain
  identical regardless of navigation mechanism.
- Canonical display-name cleanup must decide the standard mechanic suffixes and the limited places
  where a provider family or protocol marker intentionally differs from the product name.
- Screenshot quota values proposed during planning were 64 files or 256 MiB per session and
  512 MiB globally, with oldest-first eviction. Reconfirm against the existing Browser plan before
  implementation.
- Suggested token-rollup trigger: do not add persistent rollups while the 1m-row benchmark remains
  below roughly 250 ms on representative hardware; record hardware and query plan with results.
- Confirm CI native/cross-target expectations before changing Grok Build release behavior.
