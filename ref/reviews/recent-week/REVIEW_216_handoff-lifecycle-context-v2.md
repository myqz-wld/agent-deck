---
review_id: 216
reviewed_at: 2026-08-08
baseline_commit: 30fd1c98eaeed829af82dddef5f295489ce42871
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review, changelog, plan archival, rebucketing, and indexes are mechanical records."
---

# REVIEW_216_handoff-lifecycle-context-v2: Handoff context and ownership deep review

## Scope and method

Invocation `hnd-0807-30fd` used paired heterogeneous Claude and Codex reviewers for four complete
primary batches: context rendering, context capture, lifecycle gates, and commit/readiness. Each
material round was rebutted or re-reviewed after its fix, followed by paired full integration and a
focused raw-tail remediation review. Reviewers inspected the uncommitted implementation against the
baseline, ran repository tests and isolated race/SQLite spikes, and did not edit the workspace.

```review-scope
src/main/adapters/claude-code/sdk-bridge/__tests__/stream-processor-user-message.test.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream.ts
src/main/adapters/grok-build/__tests__/message-controller.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/message-controller.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.cutover.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/acquisition-response.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-change-copy.ts
src/main/ipc/__tests__/adapters-message-dispatch.test.ts
src/main/session/continuation-context/__tests__/checkpoint-background-materializer.test.ts
src/main/session/continuation-context/__tests__/checkpoint-background-refresh.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold.test.ts
src/main/session/continuation-context/__tests__/message-classifier.test.ts
src/main/session/continuation-context/__tests__/preparation-cache.test.ts
src/main/session/continuation-context/__tests__/preparation-renderer.test.ts
src/main/session/continuation-context/__tests__/renderer.test.ts
src/main/session/continuation-context/__tests__/runtime.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/__tests__/source-spool.test.ts
src/main/session/continuation-context/checkpoint-background-materializer.ts
src/main/session/continuation-context/checkpoint-fold-coverage-gap.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-projection.ts
src/main/session/continuation-context/handoff.ts
src/main/session/continuation-context/preparation-cache.ts
src/main/session/continuation-context/preparation-renderer.ts
src/main/session/continuation-context/provider-payload.ts
src/main/session/continuation-context/raw-user-tail.ts
src/main/session/continuation-context/renderer.ts
src/main/session/continuation-context/runtime.ts
src/main/session/continuation-context/service.ts
src/main/session/continuation-context/source-spool-raw-tail.ts
src/main/session/continuation-context/source-spool.ts
src/main/session/continuation-context/types.ts
src/main/session/hand-off/__tests__/cutover-coordinator.test.ts
src/main/session/hand-off/__tests__/executor.test.ts
src/main/session/hand-off/__tests__/input-buffer.test.ts
src/main/session/hand-off/__tests__/trusted-continuation-gate.entry-expiry.test.ts
src/main/session/hand-off/__tests__/trusted-continuation-gate.test.ts
src/main/session/hand-off/__tests__/ui-coordinator.test.ts
src/main/session/hand-off/cutover-coordinator.ts
src/main/session/hand-off/executor.ts
src/main/session/hand-off/input-buffer.ts
src/main/session/hand-off/source-precondition.ts
src/main/session/hand-off/trusted-continuation-gate.ts
src/main/session/hand-off/ui-coordinator.ts
src/main/store/__tests__/worktree-transition-lifecycle.test.ts
src/main/store/session-handoff-alias-repo.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/worktree-transition-delete.ts
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/hand-off-labels.test.ts
src/renderer/components/hand-off/labels.ts
src/shared/session-hand-off-execution.ts
src/shared/types/session.ts
```

## Findings and fixes landed

| Area | Confirmed defect | Resolution |
|---|---|---|
| UI preparation | A legal source spool above 8 MiB was charged to an 8 MiB resident cache and rejected. | Separate resident and aggregate spool pools now admit legal captures while retaining LRU and pinned accounting. |
| Rendering | History shrink mutated inputs without re-rendering, and byte overflow could be mislabeled as instruction capacity. | Every reduction re-renders with progress guards; terminal byte and token failures retain distinct codes. |
| Provider privacy | Canonical ids, evidence, hashes, paths, and the private prompt could leak into provider or persisted snapshots. | Context v2 uses one provider projection; attachment and coverage-marker data are abstracted; every adapter separates provider and persisted text. |
| Ownership diagnostics | Sealed or durably committed predecessors collapsed into the same “handoff in progress” sentinel. | Production acquisition is discriminated and durable-aware; committed copy names the successor and finalization failure seals the source. |
| Rollback races | Rename could replay an in-flight input twice; retries could start after reactivation; Grok could persist rollback input twice. | Shift-before-await, post-backoff detach checks, token-guarded epoch cleanup, and persisted-event suppression close those races. |
| Readiness and cleanup | Observed capacity skipped acceptance, prepared lower retry could be discarded, and failure copy understated at-least-once effects. | All capacities await acceptance, strict cleanup precedes retry, late cleanup is bounded, and UI/MCP share one effect classifier. |
| Capture/fold | TTL, excluded-row accounting, oversized leading revisions, gap ranges, zero-timeout calls, and commit diagnostics had gaps. | Reads enforce TTL; semantic filters align foreground/background/raw tail; markers advance; ranges union; deadlines and CAS diagnostics are exact. |
| Final integration | Non-message telemetry could consume raw-user-tail scan allowance before an older eligible message. | The raw-tail query selects only message rows, matching the classifier precondition; the default capture regression proves retention. |

No confirmed CRITICAL finding remained. Every release-relevant HIGH and MEDIUM finding was fixed and
independently re-verified before integration acceptance.

## Validation and evidence

- Full Electron-ABI suite passed 473 files and 3,930 tests; one credentialed live smoke remained
  intentionally skipped.
- `pnpm typecheck` passed both node and web configurations.
- `pnpm build` completed main, preload, renderer, and build-info generation.
- `git diff --check` passed, and no changed production source exceeded 500 lines.
- Final raw-tail focused suites passed 37/37; paired reviewer spikes additionally covered 128-row
  pagination, equal-revision ties, cross-session input, wrapper warnings, relevant-message guard
  exhaustion, and excluded telemetry.
- Reviewer worktree snapshots remained unchanged across every review round.

## Residual risk and accepted boundaries

- Availability-first rollback permits an already-running uncancellable replay to settle after a new
  owner epoch opens. Copy describes uncertain late delivery; no new old-epoch retry starts after
  reactivation.
- Timed-out successor cleanup is bounded process-local best effort. Durable provisional-successor
  cleanup and restart reconciliation remain future architecture work.
- One pathological oversized revision may be scanned fully to produce an honest digest marker, and
  a marker that cannot fit beside every required fact remains in bounded background backoff.
- This delivery does not add an application-global reservation spanning cached UI previews,
  in-flight UI preparation, and one-shot MCP capture.
- Near the 32 MiB ceiling, a large generated wrapper message may exhaust the relevant-message scan
  work guard before its wrapper-specific warning is classified. The generic resource-guard warning
  remains accurate; preserving the pre-parse bound is preferred over weakening it for this rare edge.

## Follow-ups

Cross-adapter replay cancellation/epoch acceptance and durable provisional-successor cleanup may be
designed separately if stronger exactly-once guarantees become a product requirement. They are not
implicit blockers for this availability-first delivery.

## Final verdict

ACCEPT WITH DOCUMENTED RESIDUALS. The reproduced lifecycle and large-context failures are closed;
provider privacy, resource bounds, durable ownership, readiness, rollback races, and warning parity
converged under paired integration review.

## Related records

- `CHANGELOG_436_handoff-lifecycle-context-v2.md`
- `PLAN_31_handoff-lifecycle-context-v2.md`
