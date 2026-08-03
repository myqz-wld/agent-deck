---
changelog_id: 418
changed_at: 2026-07-30
---

# CHANGELOG_418_automatic-worktree-cwd-transition: Move sessions across worktrees automatically

## Summary

`enter_worktree` and `exit_worktree` now own the complete in-app session transition. After the
provider observes the exact successful MCP tool result, Agent Deck fences the old turn, performs
an expected interrupt, changes the runtime and persisted working directory, and automatically
continues without a manual `cd` or a user follow-up.

## Changes

### Durable transition protocol

- Add the v059 structured worktree transition and FIFO buffered-input tables.
- Persist generation, direction, phase, original and target cwd, frozen Git identity, exact tool
  use, continuation identity, cleanup options, timestamps, and recovery diagnostics.
- Enforce legal phase changes with compare-and-set updates while mirroring the legacy
  `cwd_release_marker` for compatibility.
- Reconcile every pending phase at startup and when a closed or archived session resumes.

### Exact turn boundary and adapter behavior

- Claim one provider-observed `(session, toolUseId, direction, generation)` instead of inferring a
  transition from an HTTP response or tool name.
- Fence later old-turn work while retaining terminal and usage accounting, suppress the expected
  interrupt notification, and deliver the fixed internal continuation before buffered user input.
- Apply the target cwd to the next Codex turn, recreate Claude through the provider-neutral
  continuation path, and reload the same Grok native session in the target cwd.
- Add rollback and unknown-runtime handling for persistence splits, target startup failures, and
  uncertain Grok process shutdown.

### Exit, lifecycle, and ownership safety

- Restore and confirm the original runtime/database cwd before removing a structured worktree.
- Check persisted, runtime, and lease references, including descendant cwd paths, and repeat the
  dirty check immediately before removal.
- Retain retryable `cleanup_pending` state on failure; never force removal unless the caller has
  explicit discard authorization.
- Transfer an active lease and buffered input atomically during handoff, reject pending handoff,
  preserve unsettled leases across close/archive, and block session/history deletion from
  orphaning them.
- Keep branch deletion opt-in and preserve the branch by default.

### MCP, UI, and documentation

- Publish strict asynchronous enter/exit result schemas with identical JSON text and
  `structuredContent`.
- Update live tool descriptions, argument/result semantics, paired Claude/Codex bundled
  instructions, and contract-drift coverage.
- Render automatic continuation progress as compact Simplified Chinese system status rather than
  a user-authored message.
- Document automatic worktree transitions in the README.

## Validation

- `pnpm typecheck`
- `pnpm test` (492 files passed, 1 skipped; 4,105 tests passed, 1 skipped)
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Prompt-asset inventory and six byte-identical backups verified by SHA-256.

## Do Not Split Protection

Worktree coordination, recovery, Git cleanup, handoff preflight, and session-delete fencing live in
dedicated modules. Every changed production source file is at or below 500 lines.

## Notes

- The currently running Agent Deck main process cannot load these main-process changes without a
  restart. A real three-provider enter/exit smoke test is therefore deferred until the branch is
  installed and Agent Deck is restarted; controller, recovery, handler, migration, lifecycle, and
  renderer behavior is covered mechanically.
- Remaining stale wording matches are intentional: `CHANGELOG_377` records the historical
  contract, the drift test contains the forbidden phrase as a fixture, and `archive_plan` repair
  hints describe a separate manual Git maintenance workflow.
