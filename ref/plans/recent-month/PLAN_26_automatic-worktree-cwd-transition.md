---
plan_id: PLAN_26
title: Automatic worktree cwd and turn transition
status: completed
created_at: 2026-07-30
updated_at: 2026-07-30
completed_at: 2026-07-30
base_branch: main
base_commit: e5a2f63eb8be1fed751d7b9eae37f2d5f1913e08
related_changelog: CHANGELOG_418
related_review: REVIEW_200
---

# PLAN_26_automatic-worktree-cwd-transition: Automatic cwd cutover at a safe turn boundary

## Goal

Make `enter_worktree` and `exit_worktree` fully responsible for changing an in-app session's
runtime and persisted cwd, ending the old provider turn safely, and continuing automatically.
Models must not execute `cd`, infer transition state, or require the user to send another message.

## Confirmed decisions

- The transition is acknowledged only by the exact provider-observed successful tool result, never
  by HTTP response completion.
- Claude, Codex, and Grok expose one public MCP contract.
- The fixed internal continuation is main-owned and is not rendered as a user-authored bubble;
  users see compact Simplified Chinese system status.
- Claude recreates through the provider-neutral continuation path because native transcript paths
  are cwd-encoded.
- Codex applies the target working directory to the next turn/start.
- Grok reloads the same native ACP session in the target cwd and rolls back or disposes fail-closed.
- A versioned SQLite state machine is the recovery authority; the legacy marker remains a
  compatibility mirror.

## Invariants

- Claim exactly one `(session, toolUseId, direction, generation)`.
- Seal post-result ingress and prevent later old-turn work from starting.
- Preserve terminal and usage accounting for the expected interrupt.
- Deliver one internal continuation before buffered user input in FIFO order.
- Reconcile every persisted phase after compaction, process restart, close/unarchive, or rename.
- Compensate runtime/database cwd splits or retain recoverable state without guessing.
- Restore and confirm the original cwd before worktree cleanup.
- Recheck runtime, persisted, lease, descendant-path, and dirty-state references immediately before
  removal.
- Transfer only active leases during handoff; reject pending transitions.
- Never force dirty removal or delete a branch without the corresponding explicit authorization.

## Completed tasks

- [x] T1: spike provider result/terminal ordering, Claude cwd continuity, and Grok session load.
- [x] T2: add v059 transition/FIFO persistence, CAS state machine, and marker compatibility.
- [x] T3: add exact tool identity, ingress/event fences, expected interruption, compensation, and
      deterministic delivery ordering.
- [x] T4: apply Codex cwd and continuation on the next turn.
- [x] T5: recreate Claude at the target cwd with the provider-neutral continuation.
- [x] T6: reload Grok at the target cwd with source rollback and unknown-runtime disposal.
- [x] T7: split enter preparation from cutover, add restore-first exit and cleanup retry, publish
      strict asynchronous MCP results, and retain explicit destructive controls.
- [x] T8: integrate startup/resume recovery, lifecycle/deletion fences, active-lease handoff,
      session rename, and neutral system projection.
- [x] T9: update live MCP descriptions, schemas, paired bundled instructions, README, drift tests,
      and prompt-asset backups.
- [x] T10: complete focused/full validation, file-level review, changelog/review records, and final
      branch delivery preparation.

## Validation result

- Full Electron-ABI suite: 492 files and 4,105 tests passed, with one intentional file/test skip.
- TypeScript node/web checks, production build, logger validation, diff whitespace validation, and
  file-level review expiry analysis passed.
- Six prompt assets and their six byte-identical backups passed SHA-256 verification.
- Every changed production source is at or below 500 lines.
- REVIEW_200 records all safety findings, fixes, stale wording classifications, and residuals.

## Delivery and recovery

- Implementation branch: `agent-deck/worktree-cwd-turn-transition`.
- Worktree:
  `./.agent-deck/worktrees/agent-deck__worktree-cwd-turn-transition`.
- Final delivery must commit and push every intended change before invoking
  `exit_worktree(deleteBranch=false, discardChanges=false)`.
- If commit or push fails, retain the worktree and marker. Never delete the branch or discard
  changes without explicit approval.
- The ignored prompt-asset backup can restore all six durable prompt assets using its manifest.

## Environment boundary

The running Agent Deck main process cannot load this branch without restarting, and restarting it
would terminate the implementation session before delivery. Real provider smoke tests therefore
remain a post-install verification step; deterministic adapter, recovery, handler, migration,
lifecycle, UI, and full-suite coverage passed in this worktree.
