---
review_id: 159
reviewed_at: 2026-07-14
baseline_commit: b64566618c64018c3343a6ae4f459ca2bf41f6bd
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused review covers only the present_plan gate, internal native-fork review, and renderer interaction scope below."
---

# REVIEW_159_present-plan-lifecycle: Blocking gate and review-fork lifecycle

## Scope and method

This focused implementation review traced the MCP handler, retained pending state, IPC ownership,
native-fork setup, child turn correlation, renderer actions, and paired runtime protocol. It used
direct code inspection, adversarial lifecycle cases, focused regressions, the complete Electron test
suite, production build output, and prompt-asset hash comparison.

```review-scope
README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts
src/main/agent-deck-mcp/__tests__/spawn-prompt.test.ts
src/main/agent-deck-mcp/tools/handlers/request-plan-review.ts
src/main/agent-deck-mcp/tools/handlers/spawn-handler-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn-prompt.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/ipc/adapters.ts
src/main/ipc/index.ts
src/main/ipc/plan-review.ts
src/main/plan-review/__tests__/deep-review-session.test.ts
src/main/plan-review/__tests__/service.test.ts
src/main/plan-review/deep-review-session.ts
src/main/plan-review/prompts.ts
src/main/plan-review/service.ts
src/preload/api/plan-review.ts
src/preload/index.ts
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.test.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/pending-rows/plan-markdown-panel.tsx
src/shared/ipc-channels.ts
src/shared/types/permission.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | The old timeout path deleted the pending entry and emitted cancellation, so a caller that correctly stopped after timeout had no gate left for later confirmation. | Added a timed-out retained state. Late decisions are dispatched as user turns and remain retryable when delivery fails. |
| MEDIUM | Reusing ordinary spawn prompt assembly would give the review child a reply anchor and lead context, allowing its first answer to steer the still-blocked parent. | Added a trusted internal suppression flag that preserves spawn lineage but omits wire prefix, context block, and placeholder. Public spawn behavior is regression-tested unchanged. |
| MEDIUM | Automatic feedback could race the child's initial or queued response and submit unrelated assistant text. | Queue a uniquely marked user turn, ignore events before that marker, collect only subsequent assistant messages, and resolve only at that turn's `finished` event. |
| MEDIUM | A committed handoff could lose a timed-out gate if successor metadata lookup failed before backend ownership moved. | Move the backend gate to the committed successor first; treat adapter metadata and renderer-card projection as best-effort work. |
| MEDIUM | Closing the review child while a correlated turn or missing-runtime enqueue was pending could wait on that same operation for five minutes. | Race enqueue against terminal abort, absorb late recovery results, abort queued turns, invoke child close immediately, and only then await the settling serialized tail. |
| LOW | The review-child prompt called a handoff predecessor the original session, directing state-changing follow-up toward a closed owner. | Refer to the current plan-owning session in both interactive-review and automatic-feedback prompt paths. |

No CRITICAL or HIGH finding remained after the fixes above.

## Validation evidence

- Focused plan-review lifecycle suite: 19 tests passed; the unchanged `present_diff` suite retained
  12 passing compatibility checks.
- Full repository suite: 306 files and 2,829 tests passed; one opt-in live smoke remained skipped.
- Production main, preload, and renderer bundles built successfully with `pnpm build`.
- Full `pnpm typecheck` passed for both node and web projects.
- Prompt assets were backed up before editing, paired Claude/Codex semantics match, check-only formal
  deep-review skills remain byte-identical, and refreshed hashes match every confirmed asset.
- Changed first-party implementation files are below 500 lines; `git diff --check` passed.
- A final development launch rebuilt main, preload, and renderer. The active installed application
  kept the single-instance lock, so no disposable second window was available for visual inspection;
  the Browser skill also failed to attach with `Cannot redefine property: process`.

## Residual risk

- Provider-native fork eligibility depends on the provider's safe active-turn boundary. Failure is
  visible and recoverable by closing/reopening review later; the application intentionally does not
  create a context-free substitute.
- An abandoned explicitly timed-out gate remains in memory until the user responds or the owning
  session closes. This persistence is the requested behavior and is bounded by session lifecycle.
- The currently running installed host must be restarted/rebuilt at a safe point before its
  main/preload processes can load the new implementation.

## Follow-ups

No in-scope follow-up remains.
