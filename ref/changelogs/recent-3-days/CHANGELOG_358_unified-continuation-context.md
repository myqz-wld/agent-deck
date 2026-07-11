---
changelog_id: 358
changed_at: 2026-07-11
---

# CHANGELOG_358_unified-continuation-context: Unify provider-neutral session continuation

## Summary

UI hand-off, MCP `hand_off_session`, and missing-provider-history recovery now use one provider-neutral Continuation Context (会话续接上下文) engine. It captures one immutable event-revision boundary, maintains a validated canonical checkpoint, retains eligible user inputs by token budget, and sends the generated evidence only through a private trusted provider turn. The successor persists the authoritative next-step instruction and continuation lineage, not the private provider prompt.

## Changes

### Revisioned persistence and immutable capture

- Added v037 event change revisions with recursive-trigger-safe INSERT / business UPDATE / DELETE allocation, zero-event session cursors, destructive rebuild epochs, legacy effective revisions, and indexed keyset paging.
- Added v038 canonical checkpoint storage with schema/hash revalidation, monotonic head and rebuild-epoch CAS, controlled same-revision refresh, three-generation retention, and session cascade cleanup.
- Added SQLite TEMP spooling that completes before the current user event and before any provider await. It preserves exact materialized rows, runtime fingerprints, revision coverage, raw-input selection, byte bounds, expiry, and cleanup ownership.
- Made session rename atomically recompute the target revision boundary and invalidate derived checkpoints while parent cascades leave no stale cursor.

### Unified Continuation Context engine

- Added one `prepareContinuationContext()` path for hand-off and recovery, with deterministic normalization, legacy-wrapper classification, evidence-backed structured checkpoint folds, bounded repair, canonical projection, and honest coverage/degradation metadata.
- Separated four independent token budgets: raw retention ceiling, target prompt capacity, checkpoint projection budget, and generator fold-input budget. No message-count setting or 200-message capacity ceiling remains.
- Added continuous newest-first eligible user-input retention, deterministic UTF-8 estimation/truncation, protected-fact validation, append-during-generation coverage, singleflight generation, and checkpoint CAS reconciliation.
- Guaranteed large-boundary progress without false coverage. Oversized folds use bounded, deduplicated edges and whole-fact prior projection; a cannot-fit revision is represented by an immutable app-owned SHA-256/evidence marker and remains `coverage-gap`, or leaves the prior revision explicitly uncovered when the marker cannot fit without active-fact loss.
- Isolated Claude and Deepseek checkpoint generation in fresh no-tool/no-MCP runtimes. Codex checkpoint generation fails closed when its no-side-effect runtime cannot attest the final model-visible tool registry, while prior checkpoints and raw evidence remain available for safe degradation.

### Trusted delivery and lifecycle orchestration

- Added a main-only symbol-branded initial-turn type. Public renderer, preload, MCP spawn, and adapter option contracts cannot construct or spoof it.
- Provider APIs receive the full private Continuation Context, while persisted successor events contain only the exact current instruction plus version, checkpoint, source-revision, hash, and origin lineage.
- Reworked UI hand-off into owner-bound Prepare / Commit / Cancel. Main freezes source runtime and revisions, generator settings, successor target/runtime options, capacity, and preparation integrity; commit accepts only an opaque preparation id and rejects every stale dimension before side effects.
- Added proactive ten-minute preparation expiry with bounded entry/byte capacity and TEMP-spool cleanup on expiry, invalidation, cancellation, replacement, and shutdown.
- Reworked MCP `hand_off_session` to use the same preparation and shared create → mandatory resource transfer → source finalize executor. Results expose bounded checkpoint/revision/token metadata, never provider prompts, instructions, spool ids, or runtime fingerprints.
- Added one process-wide per-source cutover lease shared by UI and MCP. Source lifecycle, event revision, rebuild epoch, runtime, lineage, and inherited target options are revalidated after successor creation and immediately before synchronous ownership transfer; drift closes the orphan without moving resources.
- Preserved post-create failure identity through UI IPC. Failed successor cleanup shows a persistent source-keyed zh-CN warning across dialog close and session navigation, blocks blind retries, and requires explicit user acknowledgement before preparation is re-enabled.
- Frozen target sandbox defaults are resolved before preparation. Adapter-incompatible permission/sandbox/write controls and non-directory cwd values are rejected before any paid generation.

### Missing-provider-history recovery

- Claude and Codex recoverers bypass generation when native provider history is usable; otherwise they synchronously capture the shared continuation snapshot before persisting the current input and create one trusted continuation turn under the stable application session id.
- Preserved model, thinking, permission, sandbox, network, additional-directory, attachments, cancellation-epoch, phantom-jsonl healing, and singleflight waiter semantics across recovery.
- Ensured every terminal recovery path cleans its TEMP spool, including cancellation, provider failure, early validation, and closed-session rollback.

### Settings, compatibility, and cleanup

- Added a dedicated “会话续接上下文” settings section with independent checkpoint provider/model/thinking and a validated 8,000–128,000 raw-retention token ceiling (default 64,000).
- Migrated legacy settings with presence-aware new-key precedence and removed the old count/sentinel keys and lifecycle UI control.
- Kept periodic summaries only for session-list display. Deleted the old resume-history injector, count-based recent-message API, free-text hand-off context builder/runners, Codex handoff runner, and summary/count-based UI and MCP branches.
- Classified valid persisted legacy hand-off/recovery wrappers as historical evidence without recursively nesting generated capsules; malformed or forged wrappers remain ordinary untrusted content or are excluded by the classifier policy.
- Updated paired bundled Claude/Codex protocols, MCP descriptions, README, UI copy, tests, and internal event naming while retaining `hand_off_session` and “接力到新会话” as workflow names.

## Validation

- Final full suite: 245 files / 2,390 tests passed.
- Focused v037/v038 migration, 100,000-row revision paging/query-plan, rename, and checkpoint repository gate: 5 files / 27 tests passed.
- Final continuation/cutover/UI regression gate: 12 files / 81 tests passed.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, staged/unstaged diff checks, changed-production-file 500-line checks, and `scripts/file-level-review-expiry.sh` passed.
- The user explicitly replaced the planned heterogeneous review with one independent Codex `gpt-5.6-sol` / `xhigh` reviewer. Its four rounds ended APPROVE with 0 CRITICAL, 4 HIGH fixed, 4 MEDIUM fixed, and no remaining material finding; this is recorded as a single-review override, not a completed heterogeneous deep review.

## Do Not Split Protection

- `src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts` and `src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts` are pre-existing provider recovery integration harnesses with shared bridge subclasses, lifecycle repositories, JSONL probes, cancellation epochs, and event-order fixtures. The Claude file shrank from 1,456 to 1,382 lines; the Codex file grew from 1,218 to 1,399 while adding the cross-provider missing-history matrix. Split each harness when its provider recovery fixture is next redesigned, so shared state is extracted once rather than duplicated across suites.
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts` was already 555 lines and now covers 671 lines of one tightly coupled app-server initialization/fallback fixture, including private trusted-turn persistence. Extract the common client/thread lifecycle mock before adding another creation mode or when the file next exceeds 700 lines.
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` remains the pre-existing 2,566-line centralized tool-registration, external-caller, spawn-limit, and schema harness (down from 2,630 lines). New Continuation Context lifecycle tests live in focused files; this suite changed only to retire the now-publicly-inaccessible legacy hand-off spawn field. Split its shared registration fixture when the next cross-tool authorization family is added.
- `src/main/ipc/__tests__/issues.test.ts` remains the unchanged-size 574-line issue IPC mock graph previously protected by CHANGELOG_357. The trusted-turn work only removes a public spoof seam from its reused creation fixture; extract that fixture when the next independent issue-session behavior is added.

## Notes

- The running development application was not restarted because it owns active implementation sessions. Main/preload behavior becomes active after a later safe restart or packaged install.
- The isolated implementation worktree and branch remain available until user verification.
