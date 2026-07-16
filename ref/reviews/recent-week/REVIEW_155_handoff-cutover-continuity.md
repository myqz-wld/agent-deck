---
review_id: 155
reviewed_at: 2026-07-12
baseline_commit: 1eddae7ccce3260083c1df6e67c7222728dc64ae
expired: false
skipped_expired: []
---

# REVIEW_155_handoff-cutover-continuity: Message-safe session handoff cutover

## Scope and method

The review started from a reproduced production failure where continuation capture stopped at
event revision 934, ordinary source telemetry advanced the row to revision 938 during preparation,
and the old exact-revision predicate rejected the handoff. The audit followed the complete MCP and
UI ownership transition: capture, source ingress, successor creation, queued and late input,
attachment ownership, resource transfer, source lifecycle finalization, provider retirement,
durable wire routing, rollback, rename, reactivation, and cache cleanup.

Two independent read-only reviewer passes challenged the lifecycle and provider-turn boundaries.
All CRITICAL/HIGH findings were fixed and re-reviewed before this record was written.

```review-scope
src/main/adapters/claude-code/__tests__/sdk-bridge.message-controller.test.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/stream-processor-retirement.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/stream-processor-user-message.test.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/message-controller.ts
src/main/adapters/claude-code/sdk-bridge/pending-cancellation.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/claude-code/sdk-bridge/send-validation.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/message-controller-handoff.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-retirement.test.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/session-retirement.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/deepseek-claude-code/index.ts
src/main/adapters/types.ts
src/main/adapters/types/agent-adapter.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.cutover.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/_deps.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-change-copy.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-finalization.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/target-adapter-validation.ts
src/main/agent-deck-mcp/tools/handlers/send.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/ipc/__tests__/adapters-message-dispatch.test.ts
src/main/ipc/__tests__/session-hand-off-finalize.test.ts
src/main/ipc/__tests__/session-hand-off-response.test.ts
src/main/ipc/__tests__/teams-handoff-routing.test.ts
src/main/ipc/adapters-message-dispatch.ts
src/main/ipc/adapters.ts
src/main/ipc/session-hand-off-finalize.ts
src/main/ipc/session-hand-off-response.ts
src/main/ipc/session-hand-off.ts
src/main/ipc/teams.ts
src/main/session/__tests__/lifecycle-scheduler.test.ts
src/main/session/__tests__/manager-delete.test.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/continuation-context/__tests__/preparation-cache.test.ts
src/main/session/continuation-context/preparation-cache.ts
src/main/session/hand-off/__tests__/cutover-coordinator.test.ts
src/main/session/hand-off/__tests__/executor.test.ts
src/main/session/hand-off/__tests__/input-buffer.test.ts
src/main/session/hand-off/__tests__/late-message-delivery.test.ts
src/main/session/hand-off/__tests__/source-precondition.test.ts
src/main/session/hand-off/__tests__/ui-coordinator.test.ts
src/main/session/hand-off/cutover-coordinator.ts
src/main/session/hand-off/executor.ts
src/main/session/hand-off/input-buffer.ts
src/main/session/hand-off/late-message-delivery.ts
src/main/session/hand-off/queued-message-snapshot.ts
src/main/session/hand-off/source-precondition.ts
src/main/session/hand-off/source-reactivation.ts
src/main/session/hand-off/ui-coordinator.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/session/manager/lifecycle.ts
src/main/session/manager/rename.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/v042-migration.test.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v042_session_handoff_aliases.sql
src/main/store/session-handoff-alias-repo.ts
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/__tests__/pin-lifecycle.test.ts
src/main/store/session-repo/rename.ts
src/main/teams/__tests__/universal-message-watcher.test.ts
src/main/teams/universal-message-watcher/index.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/shared/types/session.ts
```

## Verdict

**PASS after fixes.** Final finding distribution:

- CRITICAL: 0
- HIGH: 7 fixed
- MEDIUM: 6 fixed
- LOW: 2 fixed

## Findings

### HIGH-1 fixed — exact revision equality rejected compatible source activity

The previous cutover required the captured event revision to remain the latest revision. Assistant
output, tool telemetry, and other append-only rows therefore invalidated a safe handoff. The source
precondition now preserves the immutable capture boundary, pages and classifies every later row,
allows compatible telemetry updates, and rejects only destructive mutation, runtime drift, rebuild
epoch changes, revision gaps, invalid attachments, or an unstable continuously changing tail.

### HIGH-2 fixed — input arriving during preparation could be lost or replayed twice

A process-wide cutover lease now owns source ingress from preparation through resource transfer.
Accepted input is persisted immediately as buffered evidence, delivered to the successor after
capture, or replayed once in FIFO order if the handoff rolls back. Replay retries are bounded,
terminal lifecycle changes discard unsafe work, and successful replay marks the source working
before the gate disappears so a second UI handoff cannot start in the execution gap.

### HIGH-3 fixed — pre-cutover provider queues and image turns were not transferable

Messages already accepted by Claude or Codex before the lease, but not yet started as a provider
turn, are now snapshotted synchronously. They are delivered before post-capture late input, with
uploaded images cloned to successor-owned paths. Claude's SDK input iterable releases exactly one
turn per result boundary; Codex keeps provider-neutral metadata in FIFO lockstep with native input.
Mandatory continuity tails may bypass ordinary queue pressure, while redirected normal sends still
retain the normal cap.

### HIGH-4 fixed — the old provider runtime could survive successful ownership transfer

Closing the source synchronously from inside its own MCP tool interrupts delivery of the tool
result, but only marking the database row closed leaves a split-brain runtime. Claude/Deepseek now
seal future input and retire after the active result has been translated. Codex drains the complete
current event iterable, clears current-turn fields, and disposes the source before another queued
turn can start. Runtime maps, clients, SDK claims, MCP tokens, and pending queues are cleaned
idempotently without deleting handoff source-history attachment paths.

### HIGH-5 fixed — one post-commit cleanup error short-circuited later revocation

MCP mark-closed, token release, and deferred runtime retirement now run as independent best-effort
steps after ownership commits. UI mark-closed, provider close, and archive follow the same rule.
All steps are attempted before the aggregated failure becomes a non-fatal successor warning.

### HIGH-6 fixed — lifecycle and identity races could commit against the wrong source

Close, delete, archive, rename, scheduler, and removal intent now seal or abort the lease before
awaited work. Reversible archive/rename replays against the surviving identity; terminal changes
discard buffered execution. Rename moves the live lease and redirects without letting a stale
source id commit. Removed-session cleanup releases the seal without retaining an unbounded id set.

### HIGH-7 fixed — resource and wire ownership did not move as one transaction

Tasks, team membership, worktree marker, pending/delivering inbound and outbound envelopes, and the
durable source-to-successor alias now move in the mandatory resource transaction. Watchers refresh a
claimed row before dispatch. MCP replies, team IPC, renderer sends, and old wire anchors resolve the
successor even after restart or source-row deletion.

### MEDIUM findings fixed

- Active preparation entries are pinned across TTL, eviction pressure, settings cleanup, and
  commit; duplicate commits cannot create a second successor.
- Late attachment clones are cleaned on every failed successor/cutover path without deleting
  source-history uploads during a successful handoff.
- Durable aliases are path-compressed, cycle/depth bounded, rename-safe, and cleared atomically with
  explicit or SDK-driven source reactivation; in-memory redirects start the same new owner epoch.
- Captured tool telemetry updates, old-sender recovery, and adapter recovery no longer duplicate
  user history or revive the closed owner.
- UI preparation rejects a genuinely working/waiting source but handoff-buffered evidence does not
  falsely change source activity and invalidate its own preview.
- Source final probes preserve reversible abort semantics, while terminal seals stay monotonic
  across later archive/rename notifications.

### LOW findings fixed

- Handoff errors and warnings now distinguish source incompatibility, late-delivery failure,
  transfer failure, successor cleanup, and source-finalization failure without exposing private
  continuation content.
- Renderer controls disable unsafe working/waiting handoff actions and keep committed-successor
  focus/archive warnings coherent.

## Validation evidence

- `pnpm test` under Electron ABI: 282 test files passed, 1 opt-in live-smoke file skipped; 2,653
  tests passed, 1 skipped.
- `pnpm typecheck`: passed.
- `pnpm build`: main, preload, and renderer production bundles passed.
- `pnpm logger:check` and `git diff --check`: passed.
- Handoff-focused regressions cover append-compatible cutover, late and pre-queued messages,
  attachments, rollback, transfer, aliases, lifecycle races, Claude/Codex turn-boundary retirement,
  UI cache leases, routing, reactivation, and independent finalization failures.
- Registry verification found the repository already on the latest stable Claude/Codex packages:
  `@anthropic-ai/claude-agent-sdk@0.3.207`, `@anthropic-ai/sdk@0.111.0`, and
  `@openai/codex@0.144.1`; the update command therefore produced no dependency or lockfile diff.

## Residual risk

- Cutover permits eight late-message delivery batches plus a final quiescence scan. A source that
  keeps producing new actionable batches beyond that bound aborts safely and retains source
  ownership instead of committing an incomplete tail.
- Durable alias resolution is cycle-checked and capped at 1,024 hops. Normal transfers compress
  predecessors; corrupt or extreme chains fail closed with no arbitrary intermediate owner.
- `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts` is 577 lines and
  `src/main/teams/universal-message-watcher/index.ts` is 597 lines. Both were already over the
  500-line guardrail before this task and contain high-risk stream/watcher state machines. Split the
  first before its next structural feature or at 600 lines, and split the watcher before its next
  structural feature or at 625 lines. Every other touched production TypeScript/TSX file is at or
  below 500 lines.
- The installed Agent Deck instance carrying this session was not restarted. Runtime behavior takes
  effect after the normal rebuild/restart or installed-app update.

## Follow-ups

No required correctness follow-up remains. The two documented file splits are maintenance triggers,
not blockers for this fix.
