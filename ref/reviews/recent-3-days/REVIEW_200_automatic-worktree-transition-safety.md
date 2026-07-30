---
review_id: 200
reviewed_at: 2026-07-30
baseline_commit: e5a2f63eb8be1fed751d7b9eae37f2d5f1913e08
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review, plan, changelog, and bucket-index maintenance are mechanical archive work."
---

# REVIEW_200_automatic-worktree-transition-safety: Automatic worktree cwd boundary

## Scope and method

Reviewed the complete transition path from provider tool-start observation through MCP acceptance,
expected interrupt, adapter cwd replacement, durable continuation/input ordering, startup
recovery, active-lease handoff, and restore-first Git cleanup. The review also checked migration
compatibility, lifecycle deletion fences, renderer authorship, public schema/document drift, and
the repository 500-line guardrail.

```review-scope
README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/cwd-transition-controller.test.ts
src/main/adapters/claude-code/sdk-bridge/cwd-transition-controller.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/message-controller.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/cwd-transition-controller.test.ts
src/main/adapters/codex-cli/sdk-bridge/cwd-transition-controller.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/grok-build/__tests__/cwd-transition-controller.test.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/cwd-transition-controller.ts
src/main/adapters/grok-build/index.ts
src/main/adapters/grok-build/message-controller.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/runtime-mutation-controller.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/sandbox-restart-controller.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/types.ts
src/main/adapters/types/agent-adapter.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.handler.test.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-worktree-preflight.test.ts
src/main/agent-deck-mcp/__tests__/worktree-contract-drift.test.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts
src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/_deps.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/worktree-preflight.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/bootstrap-infra.ts
src/main/notify/event-router.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/hand-off/ingress-guard.ts
src/main/session/manager-team-coordinator.ts
src/main/session/manager.ts
src/main/session/manager/lifecycle.ts
src/main/session/manager/rename.ts
src/main/session/worktree-transition/__tests__/coordinator-observe.test.ts
src/main/session/worktree-transition/__tests__/git-cleanup.test.ts
src/main/session/worktree-transition/__tests__/recovery.test.ts
src/main/session/worktree-transition/__tests__/resume-recovery.test.ts
src/main/session/worktree-transition/__tests__/tool-invocation-registry.test.ts
src/main/session/worktree-transition/constants.ts
src/main/session/worktree-transition/coordinator.ts
src/main/session/worktree-transition/git-cleanup.ts
src/main/session/worktree-transition/ingress-guard.ts
src/main/session/worktree-transition/lifecycle-policy.ts
src/main/session/worktree-transition/projection.ts
src/main/session/worktree-transition/recovery.ts
src/main/session/worktree-transition/resume-recovery.ts
src/main/session/worktree-transition/state-machine.ts
src/main/session/worktree-transition/tool-invocation-registry.ts
src/main/session/worktree-transition/transition-delivery.ts
src/main/session/worktree-transition/types.ts
src/main/store/__tests__/v059-worktree-cwd-transitions.test.ts
src/main/store/__tests__/worktree-transition-lifecycle.test.ts
src/main/store/db.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v059_worktree_cwd_transitions.sql
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/schema-capabilities.ts
src/main/store/session-repo/worktree-transition-delete.ts
src/main/store/worktree-transition-input-repo.ts
src/main/store/worktree-transition-repo.ts
src/main/store/worktree-transition-row.ts
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/message-viewer.test.tsx
src/renderer/components/activity-feed/viewers/message-content.ts
src/shared/types/session.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Active-lease handoff originally moved only the marker/lease, leaving the source database cwd at the worktree and allowing the successor cleanup path to conflict with stale ownership. | Transfer transition and FIFO input ownership, set successor cwd/marker to the worktree, and restore source cwd/marker to the original directory in one SQLite transaction. The still-live source runtime remains an independent cleanup fence until handoff retirement finishes. |
| HIGH | Cleanup reference checks that compared only exact paths could remove a worktree while another session runtime or persisted cwd pointed at a descendant directory. | Normalize paths and reject the same worktree or any descendant across session rows, every adapter runtime, and every unsettled lease before the second dirty check/removal. |
| HIGH | A failed Grok target startup followed by an unconfirmed half-started process stop could leave runtime ownership ambiguous. | Dispose the runtime fail-closed whenever either the old process stop or the half-start cleanup result is unknown; never claim a cwd rollback that cannot be proved. |
| MEDIUM | Direct deletion and history cleanup queries broke predecessor-schema fixtures that intentionally do not contain v059 tables. | Add a schema-capability probe, preserve pre-v059 compatibility, reject unsettled structured deletion, and transactionally delete only settled transition/input rows. |
| MEDIUM | Session rename onto a cleared target transition could collide with stale target buffered-input rows. | Delete the cleared target's inputs and transition before renaming the source lease and FIFO rows. |
| MEDIUM | Repeating `exit_worktree` while its accepted result was still pending could attempt a second transition instead of returning the durable acceptance. | Return the existing `waiting-tool-result` identity and leave the original exact provider result authoritative. |
| MEDIUM | New responsibilities pushed six near-limit production files beyond 500 lines. | Extract worktree handoff preflight and guarded session deletion, keep adapter bridges as thin controller delegates, and move worktree-specific tests out of an existing oversized test file. Every changed production file is now at or below 500 lines. |
| LOW | Bootstrap coverage did not model the new recovery module and could not prove ordering relative to hooks/MCP startup. | Mock and assert adapter initialization, worktree recovery, resume listener installation, then hook/MCP startup in that order. |

## Prompt-asset controls

- User Custom Points: none.
- Source confirmation: the approved D6 scope is exactly the live tool descriptions, published
  argument/result schemas, enter/exit structured error contracts, and paired bundled Claude/Codex
  instructions.
- Inventory:
  `.prompt-asset-improver/local/inventory.json`, scanned
  `2026-07-30T15:07:54Z`, expires `2026-08-06T15:07:54Z`.
- Byte-identical pre-edit backup:
  `.prompt-asset-improver/local/backups/20260730T142233Z/`.
- Restore method: validate each manifest SHA-256, then copy each listed `backup_path` byte-for-byte
  over its corresponding `original_path`. The local inventory and backups are ignored and are not
  part of the commit.
- No changed bundled document contains a Markdown link requiring target repair. The paired
  contract-drift test proves their public transition semantics remain aligned.

## Stale wording classification

- `ref/changelogs/recent-month/CHANGELOG_377_worktree-lifecycle-contract.md` is an immutable
  historical statement of the superseded behavior.
- `src/main/agent-deck-mcp/__tests__/worktree-contract-drift.test.ts` intentionally embeds the old
  sentence as a forbidden-string regression fixture.
- `archive-plan/impl-ff-merge.ts` uses “cd into worktree” for a separate manual repair of plan
  metadata on a Git branch; it does not describe `enter_worktree` or `exit_worktree`.
- No active MCP description, schema, bundled instruction, or README text retains the old
  manual-cwd contract.

## Validation

- Full Electron-ABI suite: 492 files and 4,105 tests passed; one file and one test intentionally
  skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed and the full changed implementation scope is
  declared above.
- Six current prompt assets and six byte-identical backups passed SHA-256 verification.
- All changed production source files are at or below 500 lines.

## Residual risk

- Main-process changes require an Agent Deck restart. Restarting the application from this
  implementation session would terminate the very session needed to commit, push, and safely exit
  the worktree, so a real Claude/Codex/Grok enter/exit smoke matrix was not run here.
- Provider boundary, restart-phase reconciliation, queued-input ordering, dirty/refusal paths,
  cleanup retry, handoff, and renderer authorship remain covered by deterministic focused and full
  suite tests. A post-install disposable-repository smoke test should still exercise the actual
  provider binaries after restart.
- Legacy marker-only sessions intentionally retain synchronous exit behavior; automatic
  transitions apply to structured v059 leases created by the new enter path.
