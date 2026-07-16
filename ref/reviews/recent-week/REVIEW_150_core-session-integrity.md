---
review_id: 150
reviewed_at: 2026-07-11
baseline_commit: 2a0998ff13d9f1766bed741fb615f69640991c69
expired: false
skipped_expired: []
---

# REVIEW_150_core-session-integrity: Handoff and spawn session integrity

## Scope

This review covered the recent handoff and continuation changes at the baseline, the standalone
Codex review supplied by the user, lead-side call-path verification, and the resulting core-session
fixes. It also covered the reported Live-page delay before a spawned session acquired tree
indentation.

```review-scope
.prompt-asset-improver/inventory.json
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts
src/main/adapters/claude-code/sdk-bridge/create-session/_deps.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-new.test.ts
src/main/adapters/codex-cli/sdk-bridge/create-session-rollback.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-new.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.test.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/deepseek-claude-code/index.ts
src/main/adapters/options-builder.ts
src/main/adapters/types.ts
src/main/adapters/types/create-session-opts.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/rate-limiter.ts
src/main/agent-deck-mcp/spawn-guards.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/tools/handlers/spawn-link-registration.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/ipc/__tests__/session-hand-off-finalize.test.ts
src/main/ipc/session-hand-off-finalize.ts
src/main/ipc/session-hand-off.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/service.ts
src/main/session/hand-off/__tests__/executor.test.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/session/manager/_deps.ts
src/main/session/manager/session-registration.ts
src/main/store/session-repo/spawn-chain.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/shared/types/session.ts
```

## Method and Gate Result

The user requested one standalone Codex reviewer (`gpt-5.6-sol`, `xhigh`) and then requested an
independent lead review of the main product paths. The supplied reviewer inspected every recent
commit and reported five findings. The lead traced the affected lifecycle, database, adapter, and
renderer paths, added regression tests, and performed a final read-only implementation audit.

Result: **APPROVE** for the implemented core scope.

- CRITICAL: 0
- HIGH: 1 fixed; 1 explicitly accepted as expected behavior
- MEDIUM: 4 fixed; 1 reviewer prompt-asset item left outside this core scope
- LOW: 1 fixed

## Findings and Resolutions

### HIGH fixed: strict Codex spawn could return a dead provisional session

`awaitCanonicalId` used the same fallback semantics as the interactive fast-return path. An early
provider exit or a 30-second `thread.started` timeout therefore resolved a temporary application id
as success. MCP spawn or handoff could continue into ownership and UI finalization even though no
usable provider thread existed.

Canonical callers now reject fallback and interruption. New-session rollback removes the
provisional row through the lifecycle manager and releases the client, token, session map, and SDK
claim. The ordinary interactive fast-return path retains its visible fallback behavior.

### MEDIUM fixed: spawned sessions appeared flat until canonical creation completed

MCP reserved fan-out capacity, then waited for the provider's canonical id before calling
`setSpawnLink`. Codex had already emitted a provisional `session-start`, so the renderer first
materialized a root row and only later received the parent/depth update.

Spawn now attaches trusted main-only parent/depth registration before provider creation. Codex
fresh and native-fork paths and the Claude/Deepseek family put that metadata on the first SDK
session row. SessionManager accepts it only on SDK `session-start`, validates it, can fill an
unlinked row created by an earlier frame, and refuses re-parenting. A synchronous callback transfers
fan-out accounting from `inFlight=1` to `activeChildren=1` without double counting; canonical
`setSpawnLink` remains an idempotent compatibility fallback.

### MEDIUM fixed: failed compensation could leave resources on a closed successor

Worktree marker, task owner, and team membership changes now run inside one outer better-sqlite3
transaction. Returned failure states throw a private rollback sentinel, so SQLite restores durable
ownership even if manual compensation also fails. Team notifications run only after commit.

### MEDIUM fixed: UI archive failure was reported as clean handoff success

The best-effort archive helper now returns a discriminated result while preserving the global
failure event. The UI handoff coordinator converts failure into `sourceFinalizationWarning`; the
successor remains valid and the dialog stays open with explicit recovery guidance.

### MEDIUM fixed: successful handoff was descriptive but not terminally constrained

The paired Claude/Codex runtime assets and MCP tool description said the tool closed its caller,
but did not command the still-running source model to stop after receiving success. The user chose
prompt enforcement rather than post-response adapter interruption.

All three trusted surfaces now require `hand_off_session` to be the final, non-parallel tool action.
Any successful result with a successor `sessionId` is terminal even when `callerClosed` is
`"failed"` or warnings are present: the source must not call another tool, edit files, send
messages, retry, or continue the task. Only an error without a successor id leaves it usable.

### LOW fixed: continuation coverage warning overstated the missing range

The persisted range remains a boundary pair. User-facing diagnostics now say coverage stops at the
covered revision and name the source capture revision, rather than claiming the covered boundary is
itself missing.

## Explicit Dispositions

- The source adapter turn is still only logically closed after successful MCP handoff. It is not
  force-terminated after returning the tool response. The user confirmed this is expected because
  the product boundary relies on prompt/tool-token constraints; no adapter-close change was made.
- The bundled standalone-reviewer prompt configuration was not changed. It is a paired durable
  prompt-asset concern outside the requested core functionality and requires a separate confirmed
  prompt-asset scope. The requested standalone reviewer did complete this review successfully.

## Validation and Evidence

- Full Electron suite: 254 files / 2,439 tests passed.
- Focused final gate: 11 files / 182 tests passed.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, `git diff --check`, and
  `scripts/file-level-review-expiry.sh` passed.
- Changed production files satisfy the 500-line guardrail; `session/manager.ts` is 490 lines and
  `tools/handlers/spawn.ts` is 489 lines after extracting focused registration helpers.
- Final read-only implementation audit found no remaining actionable spawn-registration,
  fan-out-accounting, handoff-transaction, or archive-warning issue.
- Paired runtime terminal wording is byte-identical, the MCP description carries the same success
  boundary, prompt inventory hashes match the edited assets, and all three pre-edit backups match
  their manifest hashes.

## Residual Risk and Do Not Split Protection

- No live provider was started for interactive tree rendering. Deterministic adapter, manager, MCP,
  and renderer tests cover the ordering, but final visual confirmation requires a safe app restart.
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` remains the pre-existing centralized MCP harness
  at 2,621 lines. This change adds one deferred-canonical spawn edge case to its shared registry
  fixture. Extract the spawn registry fixture when the next independent spawn lifecycle family is
  added.
- `src/main/session/__tests__/manager-ingest.test.ts` remains the pre-existing integrated ingest
  harness at 978 lines. These tests reuse its SDK/hook ordering state; split that fixture when the
  ingest pipeline is next redesigned.
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts` remains
  below its protected 700-line revisit trigger at 696 lines. Strict fallback cases were placed in
  the existing early-error cleanup harness rather than expanding this file past the trigger.

## Follow-ups

- Restart the application when it is safe to terminate active implementation sessions, then verify
  that fresh and native-fork children render indented on their first visible Live update.
- If standalone reviewer policy should become a bundled supported workflow, open a separate paired
  Claude/Codex prompt-asset change with explicit editable-file confirmation and backups.
