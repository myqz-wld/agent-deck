---
changelog_id: 377
changed_at: 2026-07-16
---

# CHANGELOG_377_worktree-lifecycle-contract: Make worktree finalization explicit

## Summary

Agent Deck's bundled Claude and Codex instructions now name the repository-local
default worktree layout, require `.agent-deck/` to be ignored, preserve worktrees
when commit or push fails, and prohibit automatic work-branch deletion.

## Changes

### Default worktree layout

- Documented `<main-repo>/.agent-deck/worktrees` as the default when neither
  `worktreePath` nor `worktreeRoot` is needed for an explicit custom layout.
- Required the main repository `.gitignore` to contain the exact `.agent-deck/`
  entry before callers use that default.
- Added `.agent-deck/` to this repository's own ignore rules.

### Finalization and deletion safety

- Defined normal completion as committing all intended changes and successfully
  pushing the work branch before calling `exit_worktree`.
- Required callers to retain the worktree and marker when commit or push fails.
- Clarified that `exit_worktree` removes the worktree directory and marker while
  keeping the local work branch by default.
- Required a fresh, explicit user approval immediately before every
  `deleteBranch: true` call. Generic completion or cleanup instructions and branch
  state do not authorize deletion.

### Prompt contract alignment

- Synchronized the lifecycle rules across bundled Claude and Codex instructions,
  MCP tool descriptions, field descriptions, and the README.
- Preserved the intentional Codex-only rule that MCP does not change the SDK cwd.
- Left the worktree handlers unchanged because they already implement the default
  directory, safe dirty-worktree rejection, marker cleanup, and branch retention.

## Validation

- `pnpm typecheck`
- Targeted worktree and MCP tool tests: 2 files, 97 tests passed.
- `pnpm test`: 319 files passed, 1 skipped; 2,899 tests passed, 1 skipped.
- `git diff --check`
- Paired Claude/Codex lifecycle contract comparison and stale-language search.
- Prompt-asset inventory refresh, six-file backup manifest, and original hash check.

## Do Not Split Protection

None. No runtime logic changed, and all touched first-party source files remain
below the 500-line guardrail.

## Notes

`deleteBranch` remains an opt-in handler argument, but bundled agents may now use
it only after the user answers a direct branch-deletion question.
