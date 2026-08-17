---
changelog_id: 578
changed_at: 2026-08-09
---

# Remote Parity Finalization

## Summary

Close the remaining non-blocking Remote parity lifecycle work: stage presentation ownership across
handoff, preserve provider-native history for Server Core forks, and keep ambiguous Remote mutation
intents reusable until Core can prove their outcome.

## Changes

- Replaced one-shot presentation transfer with a staged transfer lease. Handoff now prepares
  presentation ownership before the durable transaction, rolls it back when that transaction fails,
  and commits the staged ownership only after the durable owner move succeeds.
- Added strict Server Core native-fork support for Claude and Codex. Fork preflight binds the exact
  live caller identity, native session, runtime selector, and canonical cwd; the identity is
  revalidated after asynchronous provider work and before collaboration commit.
- Accepted Codex's temporary-to-canonical registration sequence only after the temporary row is
  consumed and the canonical row proves the expected parent/depth lineage. Missing callbacks,
  retained temporary rows, identity drift, and lineage mismatch all fail closed with strict cleanup.
- Made fork rollback exhaustive: provider close and child-only discard run independently, and the
  durable child row is removed only when at least one provider cleanup path proves completion.
- Restricted Remote intent retirement to success or genuinely definitive pre-dispatch rejection.
  Post-dispatch-capable `service_stopped` and `stale_scope` results now retain the original intent and
  idempotency identity for a safe retry.
- Removed the unused presentation `transferSession` API and added mutation-sensitive regressions for
  the three security-relevant fork rejection branches.

## Validation

- Final Electron-ABI suite passed 860 files with 2 designed skips and 5,610 tests with 3 designed
  skips.
- Final focused collaboration/transition validation passed 22 files and 89 tests; the extracted
  spawn suite passed 16/16 and counterfactual mutations proved the new guards are discriminating.
- `pnpm typecheck` passed both TypeScript projects, architecture boundaries, and the 121-candidate
  Core Node boundary gate.
- Production build, Linux-headless packaging/static checks, `git diff --check`, cached diff check,
  and changed-file size limits passed after the production repairs. The later delta was test-only.
- Three paired heterogeneous review rounds converged to COMPLETE/PASS from both Claude and Codex,
  with no remaining in-scope finding.

## Evidence Limits

- Full and Feishu packaging/static acceptance is complete, but live production acceptance still
  requires a real supported Linux host with systemd, rootless Podman/cgroup v2/subuid-subgid, and
  the production Feishu/Core SSH configuration and credentials. The macOS Colima environment is not
  treated as a substitute.
- The selected Git executable and repository metadata/config/hooks remain trusted during
  `enter_worktree`; hostile same-UID replacement of Git metadata is outside the adopted contract.
  Workspace target paths, cleanup, rollback, and lifecycle races remain inside it.
- No shared Electron, SSH, Relay, Worker, VLESS, or Colima process was restarted, stopped, or killed.
