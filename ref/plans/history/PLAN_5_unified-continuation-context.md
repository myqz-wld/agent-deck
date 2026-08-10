---
plan_id: PLAN_5
title: Unified Continuation Context Engine
status: completed
created_at: 2026-07-10T20:43:48-07:00
updated_at: 2026-07-11
completed_at: 2026-07-11
owner_task_id: e6d82a0a-2f5a-4f8e-b742-ec8fabe2aed9
base_branch: main
base_commit: e4729c31a11942a0bb9788f682f25e08a498a541
implementation_worktree: /Users/wanglidong/Repository/agent-deck/.agent-deck/worktrees/codex__unified-continuation-context
implementation_branch: codex/unified-continuation-context
implementation_baseline_commit: 92382b43aae51875531c7f56a08550acdc9dad9e
baseline_manifest: PLAN_5_unified-continuation-context/BASELINE_MANIFEST.txt
---

# Unified Continuation Context Engine

## Implementation Progress

- P0 complete: isolated baseline remains at commit
  `92382b43aae51875531c7f56a08550acdc9dad9e` on
  `codex/unified-continuation-context`; the implementation worktree was clean at handoff.
- P1 complete on 2026-07-10: the user confirmed the exact prompt-asset scope and naming map;
  `.prompt-asset-improver/inventory.json` now targets this worktree; 11 existing editable assets
  were backed up under
  `.prompt-asset-improver/local/backups/20260711T042355Z/` with a validated manifest and matching
  original SHA-256 hashes. New prompt assets are inventoried with `exists:false`.
- P2 complete on 2026-07-10: v037 adds trigger-owned event revisions/rebuild epochs, legacy
  effective revisions, zero-session state, an expression-index keyset repository, and atomic rename
  recomputation. The integrated focused gate passed 17 tests, including recursive triggers,
  production same-ID tool merge, 100,000-row no-gap pagination/query-plan checks, and rename cases;
  four affected legacy SQLite suites passed 62 tests; typecheck and diff checks passed.
- P3 complete on 2026-07-10: v038, the canonical Zod/provider JSON schema, deterministic JSON/hash,
  read revalidation, monotonic head+rebuild-epoch CAS, same-revision refresh gate, three-generation
  validated retention, session cascade, append-during-generation behavior, and atomic rename
  invalidation are covered. The P3 focused gate passed 17 tests and related P2/rename regressions
  passed 57 tests.
- P4 complete on 2026-07-10: the provider-neutral `prepareContinuationContext()` path now includes
  four independent budgets, deterministic UTF-8 estimation/truncation, legacy-aware classification,
  canonical projection, continuous token-budgeted raw tail with no 200-message control, pre-await
  SQLite TEMP capture, bounded fold/repair, evidence and protected-fact validation, checkpoint CAS,
  preparation cache, singleflight, deterministic rendering, and honest degradation/coverage.
  Claude/Deepseek use fresh empty-directory, one-turn `tools:[]`/no-MCP structured runtimes with
  output caps and Deepseek capability caching. Codex 0.144 `outputSchema`, empty environments and
  runtime roots, empty dynamic tools, base-instruction/config isolation, and output caps are wired
  and inspected, but its missing final model-visible registry attestation deliberately fails the
  checkpoint generator closed to prior-checkpoint/raw-only. The integrated P2-P4 gate passed 107
  tests, including 100,000-row paging, 300 retained messages, cross-purpose byte identity, forged
  evidence, bounded repair, deadline coverage, malicious tool requests, and ordinary Codex oneshot
  regressions; typecheck and diff checks passed.
- P5 complete on 2026-07-10: a symbol-branded main-only `InternalInitialTurn` and shared fresh
  executor now keep ordinary public spawn separate from trusted continuation creation. The provider
  receives the full continuation prompt while Claude, Codex, and Deepseek persist only the exact
  next-step instruction plus version/checkpoint/source/revision/hash lineage and
  `messageOrigin:'continuation'`. Public adapter options, renderer/preload types, MCP schemas, and
  `SpawnSessionArgs` contain no trusted variant; runtime spoof fields are stripped/rejected. A
  shared 102,400-character user-message SSOT preserves ordinary behavior, while branded provider
  prompts use frozen target-token and 512-KiB guards and may exceed the ordinary character cap.
  P5 focused/SDK regression gates passed 159 and 304 tests respectively, covering ordinary
  create/resume, attachments, provider/persist split, public spoofing, >102,400 trusted prompts,
  Codex resume-only behavior, and second/third-generation no-capsule nesting; typecheck/diff passed.
- P6 complete on 2026-07-10: Claude and Codex recoverers synchronously freeze the same TEMP spool
  and target/generator snapshots before the current user event, bypass preparation when native
  provider history exists, and use a branded trusted continuation only for a missing provider
  transcript under the stable Agent Deck application SID. Claude permission/sandbox restart uses
  the same path; Codex sandbox remains its correct hot next-turn patch. Native resume, phantom-jsonl
  healing, early user visibility, attachments, thinking/model/sandbox/network/directories,
  cancellation epochs, waiter behavior, closed rollback, and cleanup on every terminal path are
  covered. Claude focused recovery passed 103 tests, Codex passed 55 tests, and typecheck/diff
  checks passed. P9 must split the two Claude recovery files that temporarily exceed 500 lines.
- P7 complete on 2026-07-10: shared IPC/preload/renderer now use owner-bound Prepare/Commit/Cancel.
  Main freezes source runtime, event/rebuild revision, generator settings, exact successor options,
  target capacity, and preparation integrity; commit sends only the opaque preparation ID and rejects
  every stale dimension before side effects. The UI exposes an editable authoritative next-step
  instruction and target controls plus a bounded read-only preview/stats/quality view. The cache is
  10-minute/8-entry/8-MiB bounded, cleans TEMP spools on every eviction/invalidation, permits one
  same-snapshot pre-spawn retry, and invalidates on source lifecycle/rename, settings, cancel, and
  shutdown. Generator settings are separated as continuationCheckpointProvider/Model/Thinking;
  token retention defaults to 64,000 in the validated 8,000–128,000 range; the count setting and UI
  are gone. Focused settings/UI/coordinator gates passed 111 tests; typecheck/logger/diff passed.
- P8 complete on 2026-07-10: MCP hand_off_session resolves the exact target before compaction, calls
  the same handoff preparation, constructs only a private branded trusted turn, and uses the shared
  create → mandatory transfer → source-finalize executor. Results contain compact checkpoint,
  revision, token, successor, and transfer metadata only. Transfer callbacks/classifiers that throw
  now close the orphan best-effort and surface its stable ID; source-finalization failure leaves the
  successor usable. Focused lifecycle/schema/spoofing/authorization gates passed 75 tests;
  typecheck/diff passed.
- P9 complete on 2026-07-11: deleted the resume-history injector, legacy character-budget handoff
  builder, count-based recent-message API, Codex handoff runner, and handoff-specific summary
  runners while retaining periodic summaries and the narrow phantom-history timestamp probe. The
  paired Claude/Codex protocols, MCP descriptions/schemas, README, UI copy, and CHANGELOG_358 now
  use Continuation Context (会话续接上下文); public spawn can no longer construct legacy handoff
  metadata. Prompt-asset backups (11 files) and all 24 refreshed inventory hashes were verified;
  no custom points exist. Preflight HIGH findings were fixed by freezing effective global sandbox
  defaults before prepare, invalidating on sandbox-setting changes, and rejecting adapter-
  incompatible safety controls before paid generation. Active cache expiry and cwd directory
  validation resolved the two MEDIUM findings. P9 cleanup passed 157 focused tests; prompt/schema
  validation passed 109 tests. Codex/Claude facades and recovery controllers were split so every
  changed production file is at most 500 lines; focused split gates, typecheck, logger, and diff
  checks passed.
- P10 complete on 2026-07-11: the full pre-review matrix passed (242 files / 2,366 tests, typecheck, build,
  logger, focused migration/repository gates, review-expiry, and diff checks). At the user's
  explicit request, the formal Claude+Codex heterogeneous review was stopped and replaced by one
  independent Codex `gpt-5.6-sol` / `xhigh` reviewer; do not represent this as a passed
  heterogeneous deep-review gate. Its first pass blocked on three HIGH and two MEDIUM findings.
  All five are now fixed: UI/MCP share a per-source cutover lease; the executor revalidates source
  lifecycle/revision/rebuild/runtime after successor creation before synchronous ownership
  transfer; MCP re-resolves frozen inherited target options; oversized checkpoint folds guarantee
  contiguous revision progress while preserving active facts; cross-purpose/signal singleflight
  is isolated; and renderer source-finalization warnings remain visible with successor focus gated
  on successful finalization. The integrated fix gate passed 10 files / 71 tests plus typecheck,
  logger, line-limit, and diff checks. The same reviewer cleared four findings on the second pass
  but kept the gate blocked on one HIGH and one MEDIUM: the cannot-fit fold path advanced an
  unchanged checkpoint and therefore claimed false coverage, while UI IPC discarded the stable
  orphan successor ID when cleanup failed. Both are now fixed. The fold path persists an app-owned,
  schema/evidence/token-validated blocked marker with a full raw-group SHA-256, exact revision/event
  bounds, and first/last evidence; it retains all prior active/blocked facts, prunes only whole
  inactive facts, remains immutable to provider output, is projected before ordinary facts, and
  keeps current/future quality at `coverage-gap`. If the marker itself cannot fit without active
  loss, no checkpoint is written and the prior→capture interval remains explicitly uncovered. UI
  commit now returns a serializable discriminated execution failure with stage, stable successor
  ID, and cleanup status; failed cleanup blocks blind retry until the user explicitly confirms the
  orphan was closed. The combined final-finding gate passed 12 files / 80 tests plus typecheck,
  logger, line-limit, and diff checks.
  The third reviewer pass cleared the HIGH and the IPC identity transport, but found one remaining
  MEDIUM: closing/reopening the dialog cleared the local cleanup-failed interlock. The renderer now
  keeps pending orphan acknowledgements outside modal state in a source-session keyed store, so
  close, session navigation, and return restore the same ID/warning and disabled retry state; only
  the explicit acknowledgement removes it. The reviewer then returned APPROVE with no remaining
  CRITICAL/HIGH/material MEDIUM finding. Final gates passed: 245 files / 2,390 tests, 5 migration/
  repository files / 27 tests, 12 continuation/cutover files / 81 tests, typecheck, production
  build, logger, review-expiry, line-limit, and diff checks. All 24 prompt-asset inventory hashes and
  11 original backups were revalidated; User Custom Points remain none. Main still matched the
  frozen HEAD, tracked diff hash, 16-path inventory, and all 16 untracked SHA-256 values. The exact
  210-path post-baseline delta (SHA-256 `745403f869846d0b87179857eaec71d5461e4d7079e58bf27a83101c46e1de76`)
  passed apply-check, was applied without moving main HEAD, and every delivered path was compared
  byte-for-byte with this worktree.
- Remaining operational action: verify the delivered behavior after a safe restart or packaged
  install. Do not restart the currently running Agent Deck instance while it owns active sessions.

## Outcome

Replace the three independent history-transfer implementations with one provider-neutral
continuation-context engine. UI handoff, MCP `hand_off_session`, and missing-provider-history
recovery must use the same checkpoint, token budget, raw-tail selection, serialization, and
degradation rules. Their lifecycle orchestration remains intentionally different.

The user-facing artifact is **会话续接上下文** (Continuation Context), not “Hand-off 简报” or a
summary. “接力到新会话” remains the workflow/action label, and `hand_off_session` remains the
public MCP tool name for compatibility.

## Confirmed User Decisions

- Use one implementation path for Claude, Codex, and Deepseek. Do not add a Codex-native special
  path.
- UI handoff, MCP `hand_off_session`, and disconnect recovery share the same context engine.
- Do not use a message-count setting to determine transferred history.
- Page history until a token budget is filled; a count may exist only as an internal page size.
- Model IDs remain free-text inputs; thinking level remains an adapter-aware dropdown.
- A handoff target can choose adapter, model, and thinking level.
- Rename “Hand-off 简报” to a term that describes the broader recovery + handoff purpose.

## Terminology and API Names

| Concept | User-facing name | Code name |
| --- | --- | --- |
| Generated portable artifact | 会话续接上下文 | Continuation Context |
| Structured durable state | 续接检查点 | Continuation Checkpoint |
| Shared preparation entry | — | `prepareContinuationContext()` |
| UI/MCP action | 接力到新会话 | handoff / `hand_off_session` |
| Missing provider history | 断连恢复 | recovery |

Use `continuation-context` for new modules, `continuationCheckpoint*` for generator settings, and
`continuationRawRetentionTokens` for the user-input retention ceiling. Keep `handOff*` only where it
describes the handoff lifecycle, lineage, or public MCP contract.

## Current Baseline and Worktree Constraint

The main worktree is intentionally dirty with the already implemented model/thinking/handoff
feature set and the 30 -> 200 default uplift:

- branch: `main`
- HEAD: `e4729c31a11942a0bb9788f682f25e08a498a541`
- observed baseline: 61 tracked files changed, 1,292 insertions, 413 deletions, plus untracked
  feature files (76 porcelain entries at plan time)
- these changes are prerequisites for this redesign and must not be reset, stashed, or lost

Before implementation, create an Agent Deck worktree from local `main`, then mirror the current
tracked diff and untracked feature files into it mechanically. Freeze and verify the tracked binary
diff and every copied untracked-file hash, then create a local baseline commit on the work branch.
Record the worktree, branch, manifest, and baseline commit here. Implementation delivery is the
delta after that baseline only: apply it back to main only if main still matches the frozen manifest;
otherwise stop for reconciliation. Do not mutate the current main worktree before final delivery.

## Goals and Invariants

1. **One deterministic projection for one committed state.** Given the same validated checkpoint,
   immutable source spool, resolved generator/target snapshots, instruction, and format version, UI,
   MCP, and recovery produce byte-identical raw-tail selection, projection, and provider prompt.
   LLM generation itself is non-deterministic; singleflight and CAS converge concurrent work onto one
   committed checkpoint head.
2. **Complete source history remains persisted.** Compaction creates derived checkpoints; it never
   deletes or rewrites the source events.
3. **Revision, not max event ID, is the correctness boundary.** An in-place tool event update must
   invalidate a preview and enter the next checkpoint delta.
4. **No silent history holes.** Checkpoint coverage advances only through a contiguous consumed
   revision from an immutable preparation spool. Deadlines/resource guards may stop at an earlier
   revision with an explicit uncovered interval; they never claim the capture high-water mark.
5. **No capsule recursion.** A provider receives the full continuation context, while Agent Deck
   persists/displays only the current continuation instruction plus context metadata.
6. **Current instruction is authoritative and never silently truncated.** Historical projection and
   raw tail shrink first. If wrapper plus the current instruction still exceeds the trusted target
   capacity/internal safety cap, handoff fails non-destructively and recovery makes an explicit
   instruction-only attempt before reporting failure. The ordinary message cap is necessary but not
   sufficient for target-context fit.
7. **Raw tail uses Codex-aligned user-input semantics.** Retain eligible model-visible user inputs
   only, newest first under a dedicated raw-retention ceiling, truncate the boundary message rather
   than skip it, and render the selected messages in chronological order. Agent Deck intentionally
   re-injects current system/developer/project instructions instead of retaining stale source copies.
8. **The checkpoint is canonical structured data.** Persist validated JSON and never mutate it for a
   smaller target. Render a deterministic `CheckpointProjection` that records the canonical hash and
   any omitted facts; never `slice()` JSON or Markdown to fit.
9. **Failure is non-destructive.** A failed prepare/spawn/transfer leaves the source usable and its
   resources owned by the source. Recovery is fail-open to older checkpoint/raw/instruction-only.
10. **Ordinary message limits remain ordinary-message limits.** The continuation provider prompt
    has a separate token budget and internal safety cap; do not globally enlarge team/user message
    bodies.
11. **No hidden 200-message capacity limit.** Remove `resumeRecentMessagesCount` as a user setting
    and consumer. Internal keyset page size is an implementation detail.
12. **Prompt history is untrusted evidence.** JSON encoding prevents delimiter spoofing, not model
   influence. A dedicated no-tool compactor runtime, explicit lower-priority boundaries, schema and
   evidence validation, and malicious-history tests reduce prompt-injection risk; the design does
   not claim an absolute model-layer guarantee.

## Scope

### Included

- Event revision infrastructure and migration from v036.
- Versioned structured continuation checkpoints and repository APIs.
- A per-preparation immutable SQLite TEMP spool used by UI, MCP, and recovery before any LLM await.
- Token estimator, budget policy, keyset pagination, raw-user-tail selection, checkpoint folding,
  deterministic rendering, validation, repair, singleflight, and degradation.
- A shared `prepareContinuationContext()` service used by all three entry points.
- A split adapter creation contract for provider prompt versus persisted/displayed instruction.
- A trusted internal initial-turn variant and lower-level fresh-session executor that are absent from
  renderer IPC, MCP Zod schemas, and public raw create options.
- UI Prepare/Commit flow with target adapter/model/thinking selected before preparation.
- MCP `hand_off_session` integration and compact result metadata.
- Claude/Codex/Deepseek structured-checkpoint generation through their existing authenticated SDK
  paths.
- Settings rename/migration and removal of the 200-message setting.
- Classification/unwrapping of legacy handoff and recovery capsules already persisted as user events.
- Prompt assets, MCP descriptions, README, changelog, tests, and migration documentation.

### Excluded

- Calling Codex `thread/compact/start` or importing native provider history.
- Replacing normal provider-native resume when its jsonl/thread still exists.
- Deleting or rewriting historical Agent Deck events after a checkpoint.
- Changing the public MCP tool name `hand_off_session`.
- Raising the global 102,400-character cap for ordinary user/team messages.
- Background LLM compaction on every active session in the first release. Checkpoints are refreshed
  lazily by the same engine at handoff/recovery; intermediate successful folds are cached. This
  avoids recurring model cost while leaving a future background scheduler behind the same API.
- An append-only full-payload event-version journal. Exact preparation snapshots are materialized in
  a bounded TEMP spool instead, avoiding quadratic storage from cumulative tool-output updates.
- A broader rewrite of task/team/worktree transfer semantics unless an integration test exposes an
  in-scope regression. Existing mandatory-transfer rollback behavior is preserved.

## Evidence and Existing Gaps

### Three divergent inputs

- UI handoff reads up to 200 events, but `event-formatter.ts` ultimately keeps only the latest 30
  formatted lines before generating its six-section text.
- MCP handoff uses `summaryRepo.latestForSession()`, which is a periodic short display summary with
  no coverage boundary.
- Recovery calls `injectResumeHistory()` directly with separate summary, count, and character
  budgets.

Sharing `buildHandOffContextPrompt()` therefore does not make the three behaviors equivalent.

### `MAX(event.id)` is not a stable boundary

`eventRepo.insert()` merge-updates `tool-use-start` and `tool-use-end` rows in place. Their payload
and timestamp change while row ID remains constant. The current `sourceMaxEventId` misses these
mutations both for checkpoint deltas and UI stale-preview checks.

A SQLite spike proved that an additive nullable `change_revision`, a per-session revision row, and
INSERT/content-UPDATE/DELETE triggers can advance revisions for both old-style SQL and new code
without recursive trigger loops. A 100,000-event in-memory spike confirmed that an expression
index on `(session_id, COALESCE(change_revision, id), id)` supports bounded keyset range scans.

### The full capsule is persisted as a user message

Claude session finalization and Codex thread-loop finalization currently persist the same `prompt`
that is sent to the provider. A successor handoff therefore stores the prior complete capsule as a
normal user event, and a later handoff can compact that capsule again. The create contract must
separate `providerPrompt` from `persistedUserText`.

### The 102,400-character limit is coupled to the wrong abstraction

The existing cap protects normal messages, adapter sends, IPC, and cross-session bodies. It also
caps the generated first provider prompt, which prevents a Codex-like 64k approximate-token tail
for English/code. Keep the normal cap, but introduce an internal continuation prompt path governed
by token budget plus a separate 512 KiB UTF-8 safety ceiling.

### Codex 0.144 reference behavior

The exact installed source tag (`rust-v0.144.0`, commit
`767822446c7a594caa19609ca435281a9ec67e0d`) shows:

- approximately four UTF-8 bytes per token;
- newest-to-oldest retained user/system/developer messages;
- a 64,000 approximate-token remote retained-message budget;
- truncation of the boundary message instead of skipping it;
- prefix/suffix middle truncation on UTF-8 boundaries;
- replacement with a compacted checkpoint plus retained inputs.

Agent Deck cannot reproduce the private remote encrypted checkpoint, but it can align the portable
selection and replacement semantics.

### Structured-output and model-window capability spikes

- Claude Agent SDK 0.3.205 exposes `Options.outputFormat`, `structured_output`, and
  `modelUsage.contextWindow`.
- Codex app-server 0.144 exposes `turn/start.outputSchema`; token usage exposes
  `model_context_window`, while `model/list` itself does not expose a context window.
- Deepseek uses the Claude-family SDK path; schema support must be probed and must fall back to
  JSON-only output plus the same validator if its provider rejects structured output.

## Routes Considered

### Route A — Unified portable continuation engine (selected)

One checkpoint schema, budget policy, raw-tail selector, and renderer across every adapter and
entry point. Provider-specific code only generates the structured checkpoint through authenticated
SDK calls.

Benefits: one management path, cross-adapter parity, testable deterministic selection, portable
handoff, and no native-history coupling. Cost: Agent Deck owns checkpoint quality, revision state,
and approximation.

### Route B — Native Codex compaction plus portable non-Codex fallback (rejected)

This would be closer to Codex internals for same-adapter Codex sessions but would create two
semantics, could not serve cross-adapter handoff, and conflicts with the user’s explicit unified-path
decision.

### Route C — Keep three workflows and share only a prompt builder (rejected)

This preserves the current coverage drift, count/character limits, stale boundaries, and summary
misuse. It does not solve the stated problem.

### Route D — Reuse periodic summaries as checkpoints (rejected)

Periodic summaries are short display metadata without a source boundary or durable structured
state. Their trigger and cost profile are also wrong for continuation context.

## Target Architecture

```text
UI handoff Prepare/Commit ----\
                              \
MCP hand_off_session ----------> prepareContinuationContext()
                              /      | capture revision/checkpoint
Provider-history recovery ----/       | fold normalized delta
                                     | choose token-bounded user tail
                                     | render portable provider prompt
                                     v
                         PreparedContinuationContext
                                     |
                  +------------------+------------------+
                  |                                     |
          handoff executor                      recovery wrapper
     spawn + transfer + close source       reuse Agent Deck session,
                                           create fresh provider thread
```

Recommended module layout:

```text
src/main/session/continuation-context/
  service.ts
  types.ts
  source-spool.ts
  message-classifier.ts
  event-normalizer.ts
  checkpoint-schema.ts
  checkpoint-generator.ts
  checkpoint-fold.ts
  token-estimator.ts
  budget-policy.ts
  context-capacity-resolver.ts
  raw-user-tail.ts
  renderer.ts
  preparation-cache.ts
  singleflight.ts
  runtime.ts
```

Split modules before any source file reaches 500 lines.

## Core Contract

```ts
type ContinuationPurpose = 'handoff' | 'recovery';

interface ResolvedContinuationGenerator {
  adapter: 'claude-code' | 'deepseek-claude-code' | 'codex-cli';
  model: string | null;
  thinking: SessionThinkingLevel;
  contextWindowTokens: number | null; // trusted main-side observation/resolution only
  configFingerprint: string;
}

interface ResolvedSuccessorSpec {
  adapter: string;
  model: string | null;
  thinking: SessionThinkingLevel | null;
  sandbox: unknown;
  permissionMode: string | null;
  networkAccessEnabled: boolean | null;
  additionalDirectories: string[];
  contextWindowTokens: number | null; // never accepted directly from renderer/MCP
  runtimeFingerprint: string;
}

interface PrepareContinuationContextInput {
  purpose: ContinuationPurpose;
  sourceSessionId: string;
  continuationInstruction: string;
  generator: ResolvedContinuationGenerator;
  target: ResolvedSuccessorSpec;
  source:
    | { mode: 'capture' }
    | { mode: 'immutable-spool'; spoolId: string };
  limits: {
    rawRetentionCeilingTokens: number;
    deadlineMs: number;
    maxFoldCalls: number;
    maxRepairCalls: number;
  };
  signal?: AbortSignal;
}

interface PreparedContinuationContext {
  version: 1;
  providerPrompt: string;
  persistedUserText: string;
  source: { eventRevision: number; maxEventId: number | null };
  checkpoint: {
    id: number | null;
    throughRevision: number;
    formatVersion: number;
    refreshed: boolean;
  };
  projection: {
    canonicalHash: string | null;
    omittedFacts: number;
  };
  quality: 'full' | 'projected' | 'coverage-gap' | 'raw-only' | 'instruction-only';
  metrics: {
    rawRetentionCeilingTokens: number;
    targetPromptCapacityTokens: number;
    checkpointProjectionBudgetTokens: number;
    generatorFoldInputBudgetTokens: number;
    estimatedPromptTokens: number;
    checkpointTokens: number;
    rawTailTokens: number;
    includedUserMessages: number;
    truncatedBoundaryMessages: number;
    foldCalls: number;
    repairCalls: number;
    elapsedMs: number;
    uncoveredRevisionRange: { from: number; to: number } | null;
  };
  warnings: ContinuationWarning[];
  preparationHash: string;
}
```

`captureContinuationSource()` creates the same immutable spool for all purposes. UI/MCP use
`source:{mode:'capture'}` and the service captures before its first await; recovery calls capture
before emitting the current user event, then passes the returned spool ID. A bare historical
revision without an immutable spool is not a valid input.

The core does not read mutable global settings, resolve public target arguments, spawn, transfer
resources, archive, close, focus, or emit UI events.

## Persistence Design

### v037 — Event revision cursor

Add `events.change_revision INTEGER NULL` and a `session_event_revisions` table. Existing rows use
`COALESCE(change_revision, id)` as their effective revision so migration does not rewrite the full
events table or generate a large WAL.

Recommended state shape:

```sql
session_event_revisions(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  rebuild_after_revision INTEGER NOT NULL DEFAULT 0
)
```

- Backfill each session revision with `COALESCE(MAX(events.id), 0)`.
- Guarded SQLite AFTER triggers are the sole revision allocator. INSERT advances the per-session
  revision and self-stamps the row; an UPDATE trigger restricted to business columns
  (`kind/payload_json/ts/tool_use_id`) advances and self-stamps same-ID tool mutations; the internal
  `change_revision` self-update cannot recursively re-enter it.
- DELETE advances the revision and sets `rebuild_after_revision`; checkpoints older than this value
  cannot be incrementally trusted and force a full rebuild. Parent-session cascade deletes are
  guarded so the trigger does not recreate a cursor for a disappearing parent.
- A session INSERT trigger creates a zero revision row even for sessions with no events.
- The same guarded triggers support an older binary/direct old-style SQL automatically. Application
  code must not pre-increment revision, so every business mutation advances exactly once.
- Add an expression index on session/effective revision/id for keyset scans.
- Keep `maxEventId` only as diagnostic/provenance metadata; never use it as checkpoint coverage or a
  stale guard.
- P2 handles rename revision recomputation only: after moving events, target revision becomes at
  least the maximum target effective revision, `rebuild_after_revision` is set to that boundary,
  source cursor cascades with the removed source, and zero-event target state still exists. P3 adds
  checkpoint invalidation once the checkpoint table exists.

Before final SQL, run the real better-sqlite3 migration test with `recursive_triggers` both at the
app default and enabled, plus `EXPLAIN QUERY PLAN` for insert/update/delete/rename and 100k-event
keyset scans.

### Immutable preparation spool

`change_revision` detects change but deliberately does not preserve old row versions. Therefore no
prepare may page mutable `events` across LLM awaits. Before the first await, all three entry points
materialize the exact rows they intend to claim into a connection-local SQLite TEMP spool:

```text
continuation_source_spool(
  preparation_id, ordinal, event_id, effective_revision,
  kind, payload_json, ts, tool_use_id
)
continuation_raw_spool(
  preparation_id, ordinal, event_id, payload_json, ts
)
```

- Capture checkpoint head, session revision/rebuild epoch, runtime fingerprint, contiguous delta
  rows, and token-selected eligible raw inputs in one synchronous DB snapshot before returning to
  the event loop.
- Recovery performs this capture before its early current-user emit. UI and MCP use the identical
  capture routine before their first generator await.
- Multi-fold generation reads only the TEMP spool. A later UPDATE/DELETE cannot move or erase an
  unread page.
- A hidden spool byte guard protects local resources. If the whole delta cannot be materialized, the
  capture stops at a concrete revision `Q`, reports `(Q, R]` as uncovered, and may only commit
  through `Q`. This is a resource guard, not a message-count/history semantic.
- TEMP rows use random preparation IDs, TTL/LRU byte accounting, and guaranteed cleanup on consume,
  cancellation, session deletion, settings invalidation, and app shutdown. They are never durable
  product history.
- Tests must UPDATE and DELETE an unread source event between fold calls and prove the spool remains
  exact while coverage never advances beyond the materialized high-water mark.

### v038 — Continuation checkpoints

Create `continuation_checkpoints` separately from `summaries`:

```sql
continuation_checkpoints(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  parent_checkpoint_id INTEGER REFERENCES continuation_checkpoints(id) ON DELETE SET NULL,
  format_version INTEGER NOT NULL,
  source_event_revision INTEGER NOT NULL,
  source_rebuild_after_revision INTEGER NOT NULL,
  source_max_event_id INTEGER,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  content_hash TEXT NOT NULL,
  generator_adapter TEXT NOT NULL,
  generator_model TEXT,
  generator_thinking TEXT,
  trigger TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  checkpoint_tokens INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, generation)
)
```

Repository operations:

- `latest(sessionId)` and `latestAtOrBefore(sessionId, revision)` re-validate Zod schema, content
  hash, and current `rebuild_after_revision` before returning a head;
- `commitCheckpoint(expectedHeadId, expectedRebuildEpoch, checkpoint)` with single-transaction CAS;
- reject coverage regression and duplicate generation;
- allow same-revision refresh only when explicitly requested;
- retain the latest three validated generations;
- reject commit if the session disappeared or `source_event_revision < rebuild_after_revision`;
- invalidate target checkpoints inside the final rename transaction, move events, recompute target
  revision/rebuild epoch, let source checkpoints/cursor cascade with source deletion, and rebuild on
  next prepare. Cover target-existing/target-missing and zero-event cases;
- cascade on session deletion/history purge, but retain across dormant/closed/archive.

Never backfill checkpoints from `summaries`; their coverage cannot be proven.

## Structured Checkpoint

Persist one canonical JSON schema containing bounded arrays/records for:

- goal and current user intent;
- active constraints and preferences;
- decisions with rationale;
- completed work and validation evidence;
- current state;
- next steps;
- open questions;
- risks;
- key files, commands, and unresolved errors.

Each fact has a stable ID, status, concise text, and evidence event revisions/IDs. The generator may
remove an active constraint, question, or risk only with explicit supersede/resolve evidence in the
current delta. Old completed facts are deterministically pruned by priority and age when the
checkpoint budget is full.

Generation rules:

1. Feed the previous validated checkpoint plus the next contiguous normalized delta chunk.
2. Bound every normalized event. A single huge tool/log event is UTF-8 safely summarized/truncated
   with source length/hash markers so it cannot prevent cursor progress.
3. Use a lowest-common-denominator JSON Schema. Claude plumbing must pass `outputFormat`, surface
   `structured_output`, and distinguish success from `error_max_structured_output_retries`; Codex
   plumbing must add `outputSchema` through `run()`/`buildTurnStartParams()` and cap collected output
   bytes. Deepseek schema capability is probed once per provider/model fingerprint and cached.
4. For provider/schema incompatibility, request JSON-only output and run the same Zod validator.
5. Allow only the configured bounded repair count. Repair may fix syntax/shape but cannot introduce
   an evidence ID outside the exact previous-checkpoint/current-delta allowlist.
6. Persist only output that passes schema, evidence-range, length, hash, and token validation.
7. On failure, keep the prior checkpoint and never write a partially valid row.
8. Use per-session/generator-config singleflight plus DB CAS; do not hold a SQLite transaction across an LLM
   await.
9. If a large first-use delta needs several folds, persist each validated intermediate checkpoint.
   A deadline stops at the last continuous revision and reports the gap instead of claiming full
   coverage.

Normalized history excludes internal thinking and raw token-usage telemetry. It retains user and
assistant messages, tool start/end state, failures, file changes, waiting-for-user state, and
task/team/session facts only when those facts were persisted as AgentEvents. Live task/team/worktree
ownership is not inferred from unrelated tables; it is handled by the handoff resource-transfer
transaction. Runtime fields read outside events are covered by the captured runtime fingerprint.

### Dedicated compactor runtime

Checkpoint generation never runs as a continuation of the source conversation:

- use a fresh one-turn runtime in an app-owned empty directory;
- load no source project/local instructions, skills, hooks, MCP servers, or conversation history;
- expose no side-effecting tools, set max turns to one, and fail closed if the runtime cannot prove
  that file/process/network/MCP tools are absent (pure in-memory planning capability may remain only
  when it cannot access external state);
- allow provider API transport but no model-initiated network/filesystem access;
- supply an app-owned system/developer prompt that labels the previous checkpoint, source events,
  repair text, and legacy content as untrusted evidence;
- Claude uses `tools: []` and structured output directly. Codex generator plumbing explicitly sends
  experimental `turn/start.environments: []` and `runtimeWorkspaceRoots: []`, supplies no dynamic
  tools/MCP, overrides base/developer instructions, and disables web/search, collaboration,
  code-mode, and other executable tool features through app-owned config overrides. Read-only
  sandbox/empty cwd and post-event rejection are defense in depth, not the primary no-tool proof.
  Deepseek follows the Claude-family isolation contract;
- cap streamed/collected output bytes before JSON parse and record generator input/output tokens,
  latency, and error subtype.

Add adversarial fixtures that ask the compactor to read files, call tools, replace system rules,
forge evidence, or emit oversized JSON. Isolation plus validation must prevent tool execution and
checkpoint persistence, while documentation avoids claiming perfect prompt-injection immunity.
Codex integration tests must inspect the actual model-visible registry/configured capabilities, not
merely observe that a sampled model chose not to call a tool. If Codex 0.144 cannot prove absence of
side-effecting tools with these controls, the Codex checkpoint generator fails closed and the shared
engine degrades to prior-checkpoint/raw-only; it must not run in a merely read-only source runtime.

### Canonical checkpoint projection

The persisted checkpoint is immutable. For each resolved target, derive a deterministic
`CheckpointProjection` containing the canonical hash, selected whole fact items, omitted counts,
and warnings. Projection priority keeps active constraints/current state/next steps/open errors
before old completed details. Projection or canonical fact pruning changes semantic quality to
`projected`; revision coverage means “processed through this source revision”, not “every historical
detail is present”. The renderer never edits or re-saves the canonical checkpoint.

## Token and Raw-Tail Policy

### Reference estimator

Use a single provider-neutral estimator based on Codex’s UTF-8-byte approximation:

```text
estimatedTokens = ceil((utf8Bytes / 4) * 1.15) + structuralOverhead
```

The 1.15 calibration factor protects non-Codex providers and JSON wrapper overhead. Finalize the
factor with a fixture corpus (English prose, code, CJK, emoji/ZWJ, combining marks, long paths,
logs) and compare against actual input usage returned by Claude/Codex/Deepseek. If a pure-JS
reference tokenizer materially reduces worst-case undercount without unacceptable bundle/startup
cost, it may replace the byte estimate behind the same interface; do not add native/WASM runtime
coupling for this feature.

### Four distinct budgets

1. `rawRetentionCeilingTokens`: user setting, default 64,000, valid integer range 8,000–128,000.
   This is the Codex-aligned ceiling for retained historical user inputs only; it is not a cap on
   current instruction, checkpoint, or generator input.
2. `targetPromptCapacityTokens`: trusted main-side estimate of what the successor can accept after
   reserving current system/project instructions and response capacity. Resolve from observed
   Claude `modelUsage.contextWindow` or Codex `model_context_window` keyed by adapter/concrete model;
   use a conservative 128k window fallback for unseen free-text models. Renderer/MCP can never
   supply this value.
3. `checkpointProjectionBudgetTokens`: target-side allowance for a projection of the canonical
   checkpoint (normally 20% of remaining historical capacity, min 2k/max 12k). It does not rewrite
   the canonical checkpoint.
4. `generatorFoldInputBudgetTokens`: independent input/output reserve for the configured checkpoint
   generator runtime, resolved from that generator’s observed window with a conservative 32k input
   fallback. Never reuse successor capacity for generator chunking.

Budget order is: resolve target capacity and reserves; charge fixed wrapper/metadata and the full
current instruction; if they fit, derive checkpoint projection and then raw retained inputs. Unused
projection capacity returns to raw history. If minimum wrapper + current instruction does not fit,
handoff fails before side effects; recovery attempts instruction-only and may still fail clearly.

The internal provider prompt also has a 512 KiB UTF-8 denial-of-service ceiling. On a classified
target context-length rejection, allow at most one deterministic lower-budget re-render/retry; do
not loop or mutate source state. The result/error reports all four resolved budgets.

Generation work has explicit cost/latency guards:

- UI and MCP: 120-second total deadline, at most four fold calls, and at most one repair call.
- Recovery: 30-second total deadline, at most one fold call, and at most one repair call.
- Each fold has a bounded input/output/collected-byte limit. Deadline/call exhaustion persists only
  validated intermediate checkpoints and returns `coverage-gap` with the exact uncovered range.
- Metrics record calls, input/output estimates/actuals, elapsed time, and coverage. Limits are
  operational safety guards, not silent claims that older history was consumed.

### Eligible user-input tail

- Query only eligible model-visible user inputs; assistant/tool state belongs in the checkpoint.
  Include normal user inputs, attachment-only inputs, and meaningful cross-session wire messages;
  exclude synthetic errors/status messages and derived context wrappers.
- Use keyset pages of 128 rows newest-to-oldest. `128` is an internal page size, not a capacity.
- Stop when the token budget is filled; do not query or count all older messages after that point.
- If the boundary message exceeds remaining budget, preserve UTF-8-safe 50/50 prefix and suffix
  with an explicit omitted-token marker, include it, and stop. Never skip it and include older
  messages.
- Reverse selected messages to chronological order before rendering.
- JSON-encode message bodies and attachment reference metadata. Never inline attachment binaries.
- A shared `classifyContinuationMessage()` recognizes new `messageOrigin`/continuation metadata and
  known legacy `Agent Deck hand-off context vN` and recovery-wrapper headers. For a valid legacy
  wrapper, unwrap only its authoritative current-instruction section with provenance; for malformed
  derived wrappers, exclude the whole wrapper and warn. The normalizer and raw selector use this
  same classifier.
- Charge the final serialized prompt again. Secondary shrink removes only the oldest messages from
  the already selected continuous suffix, then re-truncates its one boundary message if needed;
  regenerate a smaller checkpoint projection if required. Never mutate canonical JSON, skip a hole,
  or discard the newest retained input first.
- Record the portable deviation from Codex remote v2: source system/developer messages are not
  retained because the target adapter injects current system/project instructions independently.

## Adapter Create Contract and Capsule Recursion Fix

Introduce a discriminated, trusted main-only initial-turn type (exact names may follow local
conventions):

```ts
type InternalInitialTurn =
  | { kind: 'ordinary'; prompt: string }
  | {
      kind: 'trusted-continuation';
      providerPrompt: string;
      persistedUserText: string;
      metadata: {
        formatVersion: number;
        checkpointId: number | null;
        sourceSessionId: string;
        sourceEventRevision: number;
        preparationHash: string;
        messageOrigin: 'continuation';
      };
    };
```

This union is absent from renderer IPC, MCP Zod schemas, `SpawnSessionArgs`, and public/raw adapter
create options. Extract a lower-level fresh-session executor: the public spawn path can construct
only `ordinary`; the authenticated handoff/recovery wrapper can construct
`trusted-continuation`. MCP handoff must call this internal executor after its own public argument
validation rather than route the capsule back through public `spawnSessionHandler`.

- Handoff successor: provider receives the full context; Agent Deck persists the continuation
  instruction and lineage/context metadata.
- Recovery: the original current user message is already persisted by the recovery entry; the
  fresh provider thread receives full context with first-user re-emission skipped.
- Seed the successor with canonical checkpoint provenance, not a source-session revision FK.
- Keep normal `MAX_USER_MESSAGE_LENGTH = 102_400` validation. Add an internal continuation prompt
  validator using trusted target capacity plus 512 KiB UTF-8 bytes. Move UI, MCP, and recovery
  current-instruction validation to the same shared 102,400 constant (replacing MCP’s current
  100,000 discrepancy).

Audit Claude finalization, Codex thread start/resume/fallback, Deepseek forwarding, option builders,
first-user emit paths, attachments, public schema stripping, and all test mocks. Add spoof tests that
prove renderer/MCP/public spawn cannot construct the trusted variant, and legacy-capsule tests that
prove second/third-generation continuation has no nested provider prompt.

## Workflow Integration

### UI handoff: Prepare / Commit

Replace “Summarize / Spawn” semantics with “Prepare / Commit”:

1. User selects target adapter, free-text model, and thinking level before preparation.
2. User edits an authoritative “下一步指令 / 补充与修正” field.
3. Main resolves and freezes both the checkpoint generator snapshot and the complete successor
   runtime spec (effective model/default, thinking, sandbox, permission, network/directories,
   observed/fallback context capacity, and settings fingerprint), then
   `SessionHandOffPrepare` calls `prepareContinuationContext({purpose:'handoff'})`.
4. Main keeps the full prepared object in a short-lived, bounded preparation cache and returns a
   preparation ID, a bounded read-only preview, revision/checkpoint/budget stats, and quality.
5. Generated checkpoint/raw history is read-only. Editing target or instruction invalidates the
   preparation and requires a cheap re-prepare; cached checkpoint folds are reused.
6. `SessionHandOffCommit` sends only preparation ID, not a renderer-edited capsule or a newly
   resolved set of defaults. Commit uses the frozen successor spec.
7. Main verifies caller/source authorization, TTL, unconsumed state, source event/rebuild revision,
   source runtime fingerprint, generator/target fingerprints, and preparation hash before any spawn
   side effect. A stale source/settings/runtime returns an actionable re-prepare error.
8. Shared handoff execution creates the successor, transfers mandatory resources, then closes and
   archives/focuses according to the existing UI lifecycle policy.

UI copy follows `UI_COPY_LANGUAGE.md` (Simplified Chinese):

- settings row/section: “会话续接上下文”;
- action: “生成续接上下文”;
- progress: “正在压缩会话上下文…”;
- generated area: read-only “续接上下文预览”;
- remove “Hand-off 简报”, “接力摘要”, and “开始总结” from this workflow.

Preparation cache policy: cryptographically random ID; 10-minute TTL; maximum 8 entries and 8 MiB
combined provider-prompt/spool accounting; source-session/caller ownership; consume atomically on a
successful spawn; retain for one same-snapshot spawn retry after a pre-spawn failure; purge on
settings change, source close/delete/rename, cancellation, LRU eviction, and app shutdown. Full
TEMP spool cleanup follows the same lifecycle.

### MCP `hand_off_session`

1. Resolve and validate cwd, adapter, model, thinking, full successor runtime, checkpoint generator,
   and both fingerprints before paying for compaction.
2. Call the same `prepareContinuationContext({purpose:'handoff'})` used by UI.
3. Use the same successor creation and mandatory resource-transfer helper.
4. Preserve MCP’s no-self-interrupt close behavior so the current tool result can finish.
5. Return checkpoint ID/version/revision, preparation hash, token stats, quality, and successor ID;
   do not echo the full provider prompt into the caller’s closing context.
6. Include continuation metadata in the first persisted successor message/lineage.

### Disconnect recovery

- If native provider jsonl/thread exists, keep the current native resume path and do not inject an
  Agent Deck continuation context.
- If it is missing, call the same core with `purpose:'recovery'`, reuse the existing Agent Deck
  session ID, and create a fresh underlying provider thread.
- Capture the same SQLite TEMP spool before emitting the current user message. Do not capture only a
  revision and query mutable rows after the emit; recovery passes the spool ID to the core.
- Preserve the current early user-message visibility, cancellation epoch, closed-session rollback,
  cwd fallback, sandbox/model/attachments, and `skipFirstUserEmit` invariants.
- Cover both `recoverAndSend` and permission/sandbox `restart-controller` missing-jsonl entry points;
  both currently share `injectResumeHistory` and must remain on the unified path before it is deleted.
- Recovery degradation order is: new checkpoint + raw tail; prior valid checkpoint + raw tail; raw
  tail; current instruction only. Invalid instruction, trusted target-capacity failure, or provider
  rejection after the bounded instruction-only attempt may block recovery clearly.

## Settings and Migration

Replace:

- `handOffProvider` -> `continuationCheckpointProvider`
- `handOffModel` -> `continuationCheckpointModel`
- `handOffReasoning` -> `continuationCheckpointThinking`
- add `continuationRawRetentionTokens` (default 64,000; integer 8,000–128,000)
- remove `resumeRecentMessagesCount`

Use a presence-aware electron-store migration based on `persistedRaw`:

- copy each old `handOff*` value only when the new key was not explicitly persisted;
- preserve provider/model/thinking exactly, applying only the existing provider-compatible thinking
  coercion;
- add old keys and `resumeRecentMessagesCount` to `REMOVED_KEYS` after migration;
- remove the July 10 count-uplift sentinel after it is no longer needed, or explicitly clean it as a
  loose legacy key;
- keep periodic `summaryProvider/model/reasoning` independent;
- move continuation controls out of “间歇总结” into a “会话续接上下文” section; label the
  provider/model/thinking row “续接检查点生成器” so it cannot be confused with the per-handoff
  target model.

Update `SettingsSet` immediate-apply behavior if a cache/singleflight must be invalidated when
provider/model/thinking/budget changes. Main validates safe integer/range and rejects NaN,
fractions, unknown keys, and incompatible thinking values. Migration tests cover old-only,
new-key-wins, invalid persisted values, legacy-key/sentinel cleanup, and restart persistence.

## Legacy Code Removal

After all callers move to the new path, remove or shrink:

- `src/main/session/hand-off/context-prompt.ts` and its old character-budget tests;
- `src/main/session/resume-history/inject-history.ts` and its count/character-budget tests;
- `eventRepo.listRecentMessages` count-based API;
- UI handoff’s `formatEventsForPrompt().slice(-30)` checkpoint path;
- MCP handoff’s `summaryRepo.latestForSession()` checkpoint path;
- handoff-specific free-text six-section runner/cleaner APIs superseded by the structured generator;
- old `SessionHandOffSummarize`/`SessionHandOffSpawn` IPC/preload names;
- comments/docs that claim 200 messages or 20,000 characters control handoff/recovery capacity.

Keep periodic summaries and `summaryRepo` for session-list display only.

## Prompt-Asset Workflow

Implementation changes durable prompt assets and paired bundled protocols. Before editing them,
invoke `prompt-asset-improver`, inventory and back up the confirmed files, and audit pairs:

- `resources/claude-config/CLAUDE.md`
- `resources/codex-config/CODEX_AGENTS.md`
- bundled Claude/Codex copies of any affected skill or MCP instructions
- continuation checkpoint system/user prompt templates
- MCP `hand_off_session` schema/description
- root `README.md` and related resource docs

The bundled Agent Deck behavior must remain self-contained.

## Failure and Concurrency Semantics

- Same session/revision/generator config: singleflight prevents duplicate paid generations.
- Different configs: DB CAS determines the winning monotonic checkpoint; losers reload and reuse or
  retry only the uncovered delta.
- CAS rechecks checkpoint head, session existence, revision, and destructive rebuild epoch in one
  transaction; a DELETE/rename during generation cannot install a pre-invalidation checkpoint.
- Invalid/timeout checkpoint output never replaces the prior valid head.
- UI stale preparation produces zero spawn/resource side effects.
- Spawn failure leaves source/resources untouched.
- Mandatory transfer failure rolls back through the existing coordinator, closes the successor,
  and leaves the source usable; cleanup failure returns the orphan successor ID explicitly.
- Source finalization happens only after successor creation and mandatory transfer succeed.
- Session deletion during prepare is an expected cancellation, not an orphan checkpoint error.
- Session rename invalidates derived state; the next prepare rebuilds from target history.
- Historical content has no higher instruction priority and runs in an isolated no-tool compactor;
  boundary/schema/evidence validation reduces but does not claim to eliminate model influence.

## Execution Task Graph

Agent Deck task IDs (created after approval; all transfer with the parent task):

| Phase | Task ID |
| --- | --- |
| P1 | `894e6384-94d1-498e-9d54-725cff563622` |
| P2 | `b18a078f-af81-4086-80a1-cea0297c8e59` |
| P3 | `27c4e88c-b6b4-4928-8290-8462849e0e68` |
| P4 | `9041a8b6-5b1d-4cda-a49e-08a7e3b9580e` |
| P5 | `b4403058-3f4e-480d-a4d8-0856e0aa1795` |
| P6 | `357cfe16-6c26-451d-b8f4-fbd9f501fdc7` |
| P7 | `e64866cf-3437-4a2d-b351-2cab49f4cdcb` |
| P8 | `cf7d5e7e-c63b-4fb1-8e93-783d0df729ca` |
| P9 | `bb4626ba-d3fc-4b22-96d2-64d904de2ac7` |
| P10 | `6c8d65d6-2a6a-459d-ad31-a40e1a757ca8` |

### P0 — Isolate the approved baseline

Dependencies: user approval.

- Create `codex/unified-continuation-context` through Agent Deck `enter_worktree` from local `main`.
- Freeze a source manifest containing tracked binary diff hash, every untracked feature path/hash,
  HEAD, branch, and timestamp. Mirror the current tracked/untracked feature baseline into the new
  worktree, excluding scratch/build artifacts but explicitly copying this ignored plan to `/tmp` or
  recording its original absolute path for the successor.
- Verify exact baseline parity, create a local work-branch-only baseline commit containing the
  mirrored prerequisite changes, and record its commit/path/branch here. This commit is an isolation
  anchor, not a main-branch delivery commit and is never pushed automatically.
- Run a focused pre-change typecheck/test smoke to ensure the mirrored baseline is sound.

Acceptance: implementation worktree contains all current feature changes, main worktree is
unchanged, and parity evidence/baseline commit are recorded. Final delivery computes only the delta
from this baseline commit, verifies main still matches the frozen manifest, and applies that delta
onto main without overwriting the pre-existing changes. If main drifted, stop and report instead of
merging. Keep the worktree/branch until the user verifies delivery; do not auto-clean it.

### P1 — Prompt-asset inventory and backups

Dependencies: P0.

- Invoke `prompt-asset-improver` and inventory the editable paired assets.
- Create timestamped backups and record hashes.
- Confirm the final naming map and self-containment boundaries.

Acceptance: every durable prompt asset to be edited is confirmed, backed up, and paired.

### P2 — Event revision migration and repository

Dependencies: P0.

- Add v037, migration registration, state repo, sole-owner guarded triggers, expression-index keyset
  queries, destructive rebuild epoch, and rename revision recomputation.
- Add migration/trigger/query-plan tests including old-style direct SQL, recursive triggers on/off,
  exactly-one increment, parent cascade, zero-event sessions, and tool merge-update.

Acceptance: INSERT, same-ID UPDATE, DELETE, and rename change the correctness boundary; 100k-event
pagination uses the intended index with no gaps/duplicates.

### P3 — Checkpoint migration, schema, and CAS repository

Dependencies: P2.

- Add v038, canonical schema, hashes, repository read revalidation, head+rebuild-epoch CAS, retention,
  cascade, and final rename invalidation semantics/tests.

Acceptance: only validated monotonic checkpoints persist; CAS conflict and destructive invalidation
are deterministic; summaries are never accepted as checkpoints.

### P4 — Core continuation-context engine

Dependencies: P2, P3.

- Implement four-budget resolver, estimator, legacy-aware classifier/normalizer, immutable SQLite
  TEMP spool, keyset fold, continuous raw tail, canonical projection, schema/repair, renderer,
  bounded preparation cache, and singleflight.
- Add the dedicated no-tool compactor runtime and provider generator interface. Wire Claude
  `outputFormat/structured_output/error subtype`, Codex `outputSchema` and output byte cap, and
  cached Deepseek capability fallback.
- Record token usage/context-window metadata when available.

Acceptance: golden fixtures reuse one committed checkpoint/spool and prove byte-identical
selection/projection/render for all purposes; >200 messages fill by token budget; large boundary
messages/events truncate and make progress; UPDATE/DELETE after capture cannot alter the spool;
deadline/call/resource coverage is honest; malicious history cannot execute a tool or persist a
forged checkpoint; Codex registry inspection proves side-effecting tools absent or the Codex
generator fails closed to the documented degraded path.

### P5 — Split provider prompt from persisted instruction

Dependencies: P0; integrate against P4 types before merge.

- Add the private discriminated initial-turn type and lower-level fresh-session executor; update
  internal adapter options/finalizers for Claude, Codex, and Deepseek without exposing the trusted
  variant in public raw/IPC/MCP schemas.
- Add continuation-only prompt cap and trusted metadata plumbing.
- Preserve ordinary caller defaults and attachment/first-message behavior.

Acceptance: successor provider sees full context, DB/UI sees only instruction + metadata, public
spoof attempts fail, ordinary spawn behavior is unchanged, and legacy/new second/third-generation
handoff contains no prior capsule text.

### P6 — Recovery integration

Dependencies: P4, P5.

- Replace Claude/Codex recover-and-send and permission/sandbox restart missing-jsonl injection with
  the same pre-emit TEMP-spool recovery wrapper.
- Preserve all current recovery lifecycle/cancellation/cwd/sandbox/model/attachment invariants.
- Remove recovery consumption of the count setting.

Acceptance: native resume bypasses the engine; missing history uses it; current user message is not
duplicated; all four degradation levels start a valid fresh provider thread where allowed.

### P7 — UI Prepare/Commit and settings

Dependencies: P4, P5.

- Add synchronized shared IPC, main registration, preload API, renderer types, dialog flow, target
  signature invalidation, stats/quality UI, and read-only preview.
- Add separated checkpoint-generator settings, raw-retention ceiling, one-time migration/server
  validation/cache invalidation, and remove lifecycle count input.

Acceptance: target is selected before prepare; no full capsule returns on commit; stale previews have
zero side effects; copy consistently uses “会话续接上下文”.

### P8 — MCP handoff and shared handoff executor

Dependencies: P4, P5.

- Move public spawn and UI/MCP handoff onto a shared lower-level executor while allowing only the
  authenticated handoff wrapper to construct a trusted continuation initial turn; keep
  origin-specific finalization callbacks.
- Make MCP resolve/freeze target+generator first, call the shared core, and return compact metadata.
- Update schemas/descriptions and spoofing/authorization tests.

Acceptance: UI and MCP use the same prepared-context fixture; MCP no longer reads summaries/counts or
returns the large prompt; failure ordering preserves source/resources.

### P9 — Remove legacy paths and update durable documentation

Dependencies: P6, P7, P8.

- Delete dead builders/runners/count APIs and rename comments/tests.
- Update paired prompt assets, README, UI copy tests, and a new changelog record/indexes.
- Check all affected source files against the 500-line guardrail.

Acceptance: no active reference claims “Hand-off 简报”, 200-message capacity, 20k-character raw
budget, or summaryRepo checkpoint semantics.

### P10 — Validation and review

Dependencies: P2–P9.

- Run focused suites after each phase, then full `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Run logger and diff checks required by the repository.
- Run migration tests with protected better-sqlite3 binding workflow.
- Run file-level review-expiry script and a deep two-reviewer review for DB/lifecycle/security/race
  risks; fix or disprove every CRITICAL/HIGH finding.
- Restart dev after main/preload changes only when it is safe for the active Agent Deck session, or
  hand off explicit restart instructions if this session owns the running app.

Acceptance: all required validations pass, review has no unresolved CRITICAL/HIGH finding, docs and
records are indexed, and the final behavior matrix is demonstrated.

## Test Matrix

### Revision and persistence

- v036 -> v037 -> v038 and fresh DB.
- Existing effective revision, new insert, same-ID tool merge-update, delete, rename, cascade.
- Old-style SQL advances revision exactly once with recursive triggers on/off; parent cascade does
  not recreate state; zero-event session has a cursor.
- Checkpoint first commit, multi-fold replacement, same-revision refresh, CAS conflict, retention.
- Await-time new event stays for next fold; delete/rename invalidates safely; destructive mutation
  between generation and CAS is rejected.
- UPDATE/DELETE an unread mutable row between folds: TEMP spool remains exact and coverage stops at
  its materialized high-water mark.

### Estimator and budget

- ASCII, code, CJK, emoji/ZWJ, combining marks, JSON escaping, long paths/logs.
- UTF-8-safe prefix/suffix truncation and explicit omitted-token marker.
- Separate raw/target/projection/generator budgets; observed/unknown windows; 64k raw default;
  oversized current instruction; token/byte double guard; target context retry/error.
- Serialized prompt re-count and deterministic shrink order.

### Raw tail and folding

- More than 200 user messages; tool-dense histories; invalid payload rows; attachments.
- Oversized newest/boundary user message stops older selection.
- No checkpoint, no delta, one/multiple chunks, timeout, repair failure, prior-checkpoint fallback.
- Carry-forward/supersede evidence and checkpoint fact pruning.
- Legacy v1 handoff capsule, malformed legacy wrapper, legacy recovery wrapper, new metadata, and
  second/third-generation continuation never nest derived context.
- Malicious historical instructions cannot call tools/read source files or persist forged evidence;
  output byte and normalized-event caps always make bounded progress.

### Entry-point parity

- Same committed checkpoint and immutable spool yield identical raw/projection/provider prompt
  through UI, MCP, and recovery core calls without independently invoking a non-deterministic LLM.
- Only lifecycle effects differ.
- Native provider history present bypasses recovery preparation.
- Recovery pre-emit snapshot excludes duplicate current message.
- UI target/instruction changes invalidate; same-ID tool update makes preview stale.
- MCP validates target before paid generation and returns no large prompt.
- Preparation cache covers authorization, random IDs, TTL/LRU bytes, settings/session invalidation,
  one-time consume, one retry, and spool cleanup.

### Adapter and lifecycle

- Claude, Codex, Deepseek provider prompt versus persisted instruction.
- Ordinary create/send remains capped at 102,400 and unchanged.
- Continuation internal prompt accepts token-valid content above 102,400 characters and rejects the
  token/512-KiB limits.
- Successor re-handoff has no capsule nesting.
- Spawn/transfer/finalize failures preserve ownership and cleanup invariants.
- Model/thinking/adapter selection and same-/cross-adapter defaults remain correct.
- Public renderer/MCP/spawn input cannot spoof the trusted continuation initial turn.
- Settings migration/validation covers old-only, new-key-wins, invalid persisted values, integers,
  ranges, NaN/fractions, unknown keys, and old sentinel cleanup.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Token estimate undercounts a provider | 1.15 safety factor, actual-usage corpus, context reserve, actionable budget error |
| Rolling checkpoint semantic drift | Structured facts, evidence IDs, carry-forward/supersede rules, raw user tail |
| Mutable event races | Session revision, immutable pre-await snapshot, stale CAS, no LLM inside DB transaction |
| First long-session preparation is slow | Keyset chunks, persisted intermediate checkpoints, deadline with honest coverage |
| Trigger write amplification | One guarded trigger-owned increment per mutation; recursive-trigger and expression-index benchmarks |
| Structured output differs by provider | Provider schema mode where supported, JSON-only fallback, same Zod validator, one repair |
| Large provider prompt harms memory/IPC | Main-side bounded preparation cache/TEMP spool, ID-only commit, bounded preview, four budgets + 512 KiB guard |
| Capsule recursion returns | Trusted provider/display split, legacy classifier, explicit multi-generation tests |
| Dirty baseline is lost in isolation | Frozen manifest, work-branch baseline commit, delta-only reconciliation guard |
| Prompt/protocol drift | Prompt-asset inventory, paired Claude/Codex audit, bundled self-containment validation |

## Independent Review Findings Incorporated

Three read-only reviews completed on 2026-07-10. No finding was rejected without a design change:

- Persistence review CRITICAL: mutable row revision alone cannot reconstruct a fixed snapshot.
  Resolution: every entry point uses the same pre-await SQLite TEMP spool; coverage stops at the
  materialized high-water mark.
- Persistence HIGH: checkpoint-head CAS misses destructive invalidation and rename was underspecified.
  Resolution: CAS includes rebuild epoch/session existence; final rename transaction invalidates
  target checkpoints and recomputes target state; source derived rows cascade.
- Integration HIGH: public spawn/MCP could not safely carry different provider/display prompts.
  Resolution: private discriminated initial turn plus a lower-level executor absent from public
  schemas, with spoof tests.
- Integration HIGH: checkpoint generator and target runtime/config were conflated.
  Resolution: explicit frozen `ResolvedContinuationGenerator` and `ResolvedSuccessorSpec`, separate
  fingerprints, capacity resolution, cache validation, and clearer settings/UI names.
- Integration HIGH: dirty-worktree isolation lacked a delivery route and legacy capsules would still
  recurse. Resolution: frozen manifest + branch-only baseline commit + delta reconciliation, and a
  shared legacy-aware message classifier/unwrap policy.
- Compaction BLOCKER/HIGH: one 64k value conflated raw retention, target capacity, checkpoint
  projection, generator input, and current instruction. Resolution: four separate budgets,
  explicit call/deadline limits, target-fit failure semantics, and full metrics.
- Compaction HIGH: JSON encoding alone did not enforce prompt-injection safety; canonical checkpoint
  conflicted with final shrink; structured-output plumbing was incomplete. Resolution: dedicated
  no-tool empty-cwd runtime, provider-specific schema plumbing/output caps, immutable canonical
  checkpoint plus deterministic projection, evidence allowlists, and adversarial tests.
- Compaction re-review HIGH: Codex `turn/start` has no ordinary `tools: []`. Resolution: explicitly
  send empty environments/workspace roots, disable executable features and MCP/dynamic tools,
  inspect the model-visible registry, and fail closed to prior-checkpoint/raw-only if 0.144 cannot
  prove side-effecting tools absent.

The revised plan still deliberately chooses TEMP spooling over an append-only full-payload version
journal: it provides an exact preparation snapshot without permanent quadratic growth from
cumulative tool-output updates. The spool has honest partial coverage and bounded resource cleanup.

## Plan Review Gate

Before implementation:

1. Run independent read-only reviews focused on (a) revision/checkpoint correctness,
   (b) lifecycle/adapter/UI/MCP integration, and (c) Codex/token/compactor semantics.
2. Incorporate valid findings into this file and record rejected findings with evidence.
3. Present the complete plan to the user through Agent Deck `present_plan`.
4. Proceed only on `decision: approved`; revise and re-present on `decision: revise`; stop on timeout.

## First Step for the Implementation Session

Read this plan in full, verify the recorded worktree/baseline parity, invoke
`prompt-asset-improver` for P1, then implement P2 (v037 event revision) with its focused migration
and merge-update tests before touching the continuation engine.

## Unresolved Questions

No blocking product question remains. The plan deliberately chooses these reviewable defaults:

- generated continuation history is read-only; the user edits only the authoritative continuation
  instruction;
- raw historical user-input retention defaults to a 64,000 estimated-token ceiling; current
  instruction, target capacity, checkpoint projection, and generator-fold input use distinct budgets;
- checkpoint refresh is lazy/on-demand in the first release rather than an always-on paid scheduler;
- UI commit rejects a stale preparation and asks for re-prepare rather than silently transferring a
  context the user did not preview.

The user may revise any of these defaults at the approval gate without changing the unified-core
decision.

## Final Status and Handoff

The implementation, remediation, and independent review were delivered to `main`. The later
session-integrity follow-up was committed and pushed as `08f387b`; interactive verification still
requires a safe application restart because the running instance owns active sessions.

Related records: [CHANGELOG_358](../../changelogs/recent-month/CHANGELOG_358_unified-continuation-context.md)
and [REVIEW_148](../../reviews/recent-month/REVIEW_148_unified-continuation-context.md).
The frozen delivery baseline is retained in
[BASELINE_MANIFEST.txt](PLAN_5_unified-continuation-context/BASELINE_MANIFEST.txt).

Completed At: 2026-07-11
