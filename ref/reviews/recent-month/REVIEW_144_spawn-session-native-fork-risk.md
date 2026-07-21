---
review_id: 144
reviewed_at: 2026-07-09
baseline_commit: c509d95b14c93d484100df269a6c829927dec373
expired: false
skipped_expired: []
---

# REVIEW_144_spawn-session-native-fork-risk: Native fork boundary and rollback review

## Scope

This review checked the approved native-fork plan against the complete uncommitted feature diff, with emphasis on authenticated source selection, active-turn boundaries, source immutability, child client/token identity, temp/canonical adoption, rollback, team failure, prompt parity, and validation coverage.

```review-scope
src/main/adapters/types/fork-session.ts
src/main/adapters/types/agent-adapter.ts
src/main/adapters/claude-code/fork-session.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/deepseek-claude-code/index.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/input-pack.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/rollback.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/source-boundary.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/target-runtime.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/instruction-reset.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/handlers/spawn-fork-preflight.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/agent-deck-mcp/tools/index.ts
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
README.md
```

## Method

- Ran an initial multi-agent read-only integration audit while Claude and Codex provider work proceeded in parallel.
- Started the configured heterogeneous adapter review, then closed Claude, Codex, and DeepSeek reviewer sessions when the user explicitly requested no adapter reviewers.
- Replaced that workflow with the single independent local collaboration sub-agent requested by the user.
- The local reviewer inspected the approved plan and complete working-tree diff, ran focused validation, reported a blocking HIGH, and re-reviewed the accepted fixes.
- Lead-side verification reproduced each accepted lifecycle issue through code tracing or focused tests before adjudication.
- Adapter review staging cache was removed after the user-aborted workflow; all three temporary adapter reviewer sessions were closed.

## Gate Result

PASS under the user-requested single-local-sub-agent review mode.

Severity distribution:

- CRITICAL: 0
- HIGH: 4 fixed
- MEDIUM: 5 fixed or explicitly dispositioned
- LOW: 2 fixed
- Residual risk: 1 documented

The formal two-adapter `deep-review` gate was skipped at the user's direction because the provider adapters were unavailable/unwanted for this run. The independent local reviewer re-review reported no remaining blocking HIGH.

## Findings and Decisions

### HIGH fixed: post-close Codex discard could orphan native child history

Trigger: mandatory team membership failed after the child was registered. The existing close path disposed the target client before `discard()` attempted `thread/delete`, so the native child could remain unreachable.

Fix: rollback now detects a disposed target client and creates an unmapped sibling with the same target-owned configuration solely for native deletion. It never uses the caller client/token. Regression coverage verifies close-before-discard order and child-only deletion.

### HIGH fixed: Claude querying origins could lose the current request

Trigger: a peer, channel, or coordinator message triggered `spawn_session`. The original origin filter could walk backward to an older human request.

Fix: accept the installed SDK's real querying human/peer/channel/coordinator origins while retaining top-level, non-synthetic, `shouldQuery`, sidechain, and tool-result guards. Tests cover each accepted origin and rejected synthetic cases.

### HIGH fixed: transcript matching briefly required the partial assistant tail

Trigger: the current user JSONL record was complete but the active assistant/tool line was concurrently partial. Requiring every active UUID would reject a safe user boundary.

Fix: require complete provenance through every active user frame, not the unfinished assistant tail. Discovery-level tests cover a non-terminated assistant record, partial matches, and ambiguous complete copies.

### HIGH fixed: Codex child rollback could delete a source-owned image

Trigger: the current source request contained `localImage`, then a fault or team setup failure closed the child before its delayed first turn consumed the queue. Cleanup previously treated every replayed image as child-owned.

Fix: app-server input packs now separate model-visible `items` from `ownedAttachmentPaths`. Source images are replayed exactly but only delegated child uploads can be unlinked. Source-only and mixed source/child ownership tests passed; the local sub-agent re-review marked the HIGH resolved.

### MEDIUM fixed: Claude discard bypassed coordinated application deletion

Raw `sessionRepo.delete` could leave a stale renderer row after the normal close event. Production Claude/DeepSeek fork cleanup now calls `sessionManager.delete`, preserving removal events and lifecycle side effects.

### MEDIUM fixed: fallback transcript discovery could choose a stale copy

Fallback discovery previously preferred a highest partial UUID overlap without uniqueness. It now requires complete active-user coverage and rejects ambiguous or partial candidates.

### MEDIUM fixed: Codex target process exit before adoption could skip resume

If the creating process exited after injection but before `adoptThread`, the child could be marked ready in a process that no longer held it. Eager attachment now occurs only while that process is alive; otherwise the first use issues `thread/resume`. The exit-before-adopt regression test passed.

### MEDIUM fixed/dispositioned: requested integration evidence

A deterministic two-client harness now holds the source in a simulated active tool-call state, proves caller-client `thread/read` completes, and verifies target-only fork/reset/delete work. A raw first-request harness covers instruction ordering for generic-to-agent, agent-to-generic, and agent-A-to-agent-B. These are self-modeling fakes, not a live provider; that limitation remains an explicit residual risk rather than being presented as live-provider proof.

### MEDIUM dispositioned: existing over-500 Codex bridge facade

The app-server client was split into 312-line client and 203-line thread modules. The pre-existing 639-line `sdk-bridge/index.ts` state-owning facade is 679 lines with thin fork wiring; substantive lifecycle logic lives in focused modules. `CHANGELOG_353` records a concrete 700-line/next-lifecycle revisit trigger.

### LOW fixed: DeepSeek adapter wiring coverage

Added symmetric validation, native resume ID, target option passthrough, and coordinated delete callback coverage.

### LOW fixed: MCP zero-prefix wording parity

Added first-turn Codex zero-prefix replay semantics to both the field schema and tool description, matching README and paired runtime prompts.

## Validation

- Final focused Codex ownership/exit/review-fix suite: 5 files and 20 tests passed.
- Final full suite: 202 files and 2207 tests passed.
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Prompt inventory and backup hashes, paired runtime semantics, English-only changed prose, JSON validity, reset-template phrases, and Markdown-link additions validated.

## Residual Risk

- No live-provider two-process test was run. The fake app-server/provider and two-client tests give deterministic ownership/order coverage but cannot independently detect future provider serialization drift. Run a manual live fork after restarting the hosting application.

## Related Records

- [CHANGELOG_353](../../changelogs/recent-month/CHANGELOG_353_spawn-session-native-fork.md)
- [PLAN_2](../../plans/recent-month/PLAN_2_spawn-session-native-fork.md)
