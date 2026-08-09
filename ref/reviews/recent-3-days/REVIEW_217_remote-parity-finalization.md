---
review_id: 217
reviewed_at: 2026-08-09
baseline_commit: a0b8a9ce85b3db016abacb8c4424c814bdfe954c
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review, changelog, plan archival, rebucketing, and indexes are mechanical records."
---

# REVIEW_217_remote-parity-finalization: Remote parity residual lifecycle review

## Scope and method

Deep-review invocation `rlp-low-followups-20260809-01` used the selected heterogeneous pair over one
complete `parity-low-followups` primary batch: Claude session
`9a385358-59f6-4b88-b7f1-ac4baddef58c` and Codex session
`019fe5f3-20b1-72c1-a0b8-64f1fec848f1`. Both reviewers independently read the primary and coupled
handoff, spawn, provider-native fork, Remote service, and renderer intent surfaces. Three rounds
covered initial adversarial review, fixed-state pressure testing, and committed regression
verification. Both reviewer sessions were shut down after COMPLETE/PASS convergence.

```review-scope
src/hosts/server-core/mcp-handoff-transfer.test.ts
src/hosts/server-core/mcp-handoff-transfer.ts
src/hosts/server-core/mcp-handoff.test.ts
src/hosts/server-core/mcp-presentation-port.ts
src/hosts/server-core/mcp-presentation.test.ts
src/hosts/server-core/mcp-presentation.ts
src/hosts/server-core/mcp-session-spawn.test-fixtures.ts
src/hosts/server-core/mcp-session-spawn.test.ts
src/hosts/server-core/mcp-session-spawn.ts
src/hosts/server-core/mcp-spawn-fork.ts
src/hosts/server-core/mcp-spawn-port.ts
src/hosts/server-core/mcp-spawn-schema.ts
src/hosts/server-core/mcp-spawn-tools.ts
src/hosts/server-core/session-create-capabilities.ts
src/main/remote-host/errors.ts
src/renderer/remote-host/remote-intent-ledger.test.ts
src/renderer/remote-host/remote-intent-ledger.ts
src/shared/remote-host/index.ts
src/shared/remote-host/public-errors.ts
```

## Findings and fixes landed

| Severity | Confirmed defect | Resolution |
|---|---|---|
| HIGH | Server Core rejected Codex's legitimate temporary-to-canonical native-fork registration, so every Codex fork rolled back. | Fork registration now requires the callback, permits a consumed temporary id, and authenticates the returned canonical row's exact lineage. |
| MEDIUM | Fork validation could use stale native/runtime/cwd identity after asynchronous preflight or provider creation. | Exact caller identity and canonical cwd are re-proved after each asynchronous boundary and before collaboration commit. |
| MEDIUM | `service_stopped` and `stale_scope` were treated as definitive even though either can be emitted after a Remote mutation applied. | Both codes are now ambiguous for intent retirement, preserving the same idempotency identity on retry. |
| MEDIUM | A provider close failure prevented the independent native-fork discard path from running. | Close and child-only discard are bounded independent phases; unproved cleanup retains the durable row and raises an aggregate failure. |
| INFO | The old one-shot presentation transfer API remained after staged handoff ownership was introduced. | Removed the dead API; the port exposes only the prepare/commit/rollback lease. |
| LOW | Three fail-closed fork branches were verified only by disposable spikes. | Added committed, mutation-sensitive regressions for retained temporary registration, missing registration callback, and post-create caller drift. |

The overlapping Claude/Codex reports were adjudicated as the same underlying findings rather than
double-counted. No CRITICAL finding was reported, and no CRITICAL, HIGH, MEDIUM, LOW, or INFO item
remains open in the reviewed scope.

## Validation and evidence

- Final Electron-ABI suite: 860 files passed, 2 skipped; 5,610 tests passed, 3 skipped.
- Final paired focused batch: 22 files / 89 tests passed. The spawn suite passed 16/16 after fixture
  extraction, and reviewer mutation runs demonstrated that each new regression fails when its exact
  production guard is removed.
- `pnpm typecheck` passed architecture boundaries, the 121-candidate Core Node gate, and both node
  and web TypeScript projects.
- Production Electron build and Linux-headless build/static checks passed after the production
  fixes. Subsequent changes were confined to committed regression tests and fixture extraction.
- `git diff --check`, cached diff checks, and the 500-line changed-file guard passed; the index stayed
  empty throughout review.
- Reviewers left source, index, refs, user files, shared processes, and Colima unchanged. Their exact
  disposable invocation subtree was removed after convergence.

## Accepted boundaries and remaining acceptance gate

- `enter_worktree` trusts the selected Git executable and repository metadata/config/hooks for the
  operation. Hostile same-UID replacement of `.git`/the Git common directory is outside the adopted
  contract; Workspace target-path derivation, fences, cleanup, rollback, handoff, spawn, and provider
  lifecycle remain in scope.
- Full and Feishu deterministic/package acceptance passes. Live production acceptance remains an
  external environment gate: a supported Linux host with systemd, rootless Podman, cgroup v2,
  subuid/subgid, plus production Feishu and Core SSH configuration/credentials. Darwin/Colima does
  not prove that gate.
- The safety stash created before merging Main remains intentionally retained and was not used as
  part of review evidence.

## Final verdict

PASS. Both heterogeneous reviewers reported COMPLETE coverage and independently verified every
stable finding fixed. The final full suite and static/package gates pass; no routine in-scope review
follow-up remains.

## Related records

- `CHANGELOG_578_remote-parity-finalization.md`
- `REVIEW_216_handoff-lifecycle-context-v2.md`
