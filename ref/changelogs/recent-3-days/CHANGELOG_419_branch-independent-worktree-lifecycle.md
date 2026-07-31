---
changelog_id: 419
changed_at: 2026-07-30
---

# CHANGELOG_419_branch-independent-worktree-lifecycle: Isolate worktree lifecycle from Git refs

## Summary

`enter_worktree` and `exit_worktree` now own only session cwd, worktree directories, leases, and
data-loss safety checks. Neither tool creates, switches, renames, or deletes Git branches or other
refs.

## Changes

### Detached, ref-neutral entry

- Replace required `baseBranch` plus optional `workBranch` with required `startPoint`.
- Resolve `startPoint` once to an exact commit and create the worktree with
  `git worktree add --detach`.
- Return `startCommit` and `headMode: "detached"` instead of branch metadata.
- Derive default worktree paths from session/time identity rather than branch names.
- Bound read-only Git checks to 30 seconds and worktree add/rollback removal to 10 minutes; document
  that empty pre-created parent directories may remain after later failures.
- Remove branch creation and deletion from immediate rollback and startup recovery, including for
  pre-existing v059 rows.

### Branch-independent exit

- Remove the leased-branch equality check from structured worktree exit.
- Remove `deleteBranch` from the MCP input and remove `workBranch` and `branchDeleted` from exit
  success results.
- Allow branch renames, branch switches, and detached worktrees without changing worktree
  ownership.

### Work preservation

- Require HEAD to remain reachable from a local branch, remote-tracking branch, or tag without
  binding the lease to any particular ref.
- Check tracked and untracked dirty state before acceptance and immediately before removal.
- Keep `discardChanges` defaulted to false. An explicitly authorized true value permits forced
  dirty-worktree removal but does not bypass lease, repository, live-reference, or durable-HEAD
  checks.
- Preserve restore-first cwd switching, cleanup retry, structured lease ownership, legacy marker
  adoption, and cross-session reference fences.
- Preserve branch/tag creation as an ordinary caller-owned Git workflow outside the MCP tools.

### Provider correlation and prompt contract

- Release an unclaimed provider-observed worktree invocation when its early-return tool result
  ends, so a corrected retry does not collide with the failed call for five minutes.
- Rewrite the MCP description and input/output field descriptions with exact defaults,
  side-effects, refusal conditions, recovery actions, asynchronous result states, and branch/ref
  non-responsibility.
- Align Claude, Codex, and Grok bundled instructions and update the README.
- Keep the retired, unregistered `archive_plan` compatibility code outside this change.

### Persistence compatibility

- Keep the v059 `work_branch`, `base_branch`, and `delete_branch` columns so historical rows remain
  readable.
- Persist empty branch metadata and `delete_branch=0` for new detached enters and exits.
- Continue storing the frozen commit in `base_commit`; no database migration is required.

## Validation

- `pnpm typecheck`
- `pnpm test` (492 files passed, 1 skipped; 4,125 tests passed, 1 skipped)
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Focused worktree cleanup, handler, provider-invocation, recovery, schema-drift, and real Git
  worktree tests passed.

## Do Not Split Protection

Every changed production source file is at or below 500 lines. Test files above the threshold
remain exempt fixtures.

## Notes

- No database migration is required because v059 rows remain readable and the retained
  `delete_branch` field is forced false for every new exit.
- Prompt assets were backed up before each confirmed contract edit under
  `.prompt-asset-improver/local/backups/20260731T062107Z/` and
  `.prompt-asset-improver/local/backups/20260731T064408Z/`.
