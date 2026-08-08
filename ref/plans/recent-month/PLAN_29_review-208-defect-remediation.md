---
plan_id: PLAN_29
title: REVIEW_208 defect remediation
status: completed
created_at: 2026-07-31
updated_at: 2026-07-31
completed_at: 2026-07-31
base_branch: main
base_commit: 6c4819855495e75b6a3fedbcce6be12342d4dd45
related_changelog: CHANGELOG_427
related_review: REVIEW_209
---

# PLAN_29_review-208-defect-remediation: Close all audited functional defects

## Goal and invariants

- Fix all fifteen findings confirmed in `REVIEW_208` without weakening lifecycle, persistence,
  filesystem, provider, or UI recovery boundaries.
- Preserve the already-landed compatibility cleanup and the deliberately retained screenshot,
  Grok alias, v61 normalization, and resource-placeholder safeguards.
- Use independent fresh `codex-cli` sessions with `gpt-5.6-sol` and `thinking=max`; do not invoke
  `simple-review` or `deep-review`.
- Keep the Git index, commits, refs, unrelated dirty state, and active Electron host unchanged.

## Confirmed design

- Separate caller identity acquisition from durable lifecycle authorization for every MCP
  transport; transfer teammate membership and collapsing message disposition transactionally.
- Treat an accepted provider turn, executable cache, skill mirror, Browser target, and spawned issue
  child as owned resources whose release/publication must be proven before local state detaches.
- Preserve canonical realpath/containment security while making absolute-path classification
  platform-aware; make renderer async state latest-request-wins and failed actions recoverable.
- When issue rollback cannot prove both provider and durable closure, expose the child id and block
  blind retry for the process lifetime rather than risk creating a duplicate.

## Completed execution

- [x] Phase 1 Batch S repaired MCP lifecycle, handoff message/member transactions, and shutdown
      observability.
- [x] Phase 1 Batch R-H secured Grok materialization and accepted Codex turn cancellation.
- [x] Phase 1 Batch U repaired issue creation, diff delivery, Windows images, permission refresh,
      and archive-failure UI; a correction added the required incomplete-rollback retry fence.
- [x] Lead integrated Phase 1 and passed focused tests, typecheck, logger, and whitespace gates.
- [x] Phase 3 Batch R-B repaired Browser target lifetime and console-domain singleflight.
- [x] Phase 3 Batch R-S implemented validated staged Codex skills mirror publication and rollback.
- [x] Phase 3 Batch R-P implemented repeated node_repl signal forwarding and bounded forced exit.
- [x] Lead inspected all diffs and passed the full test, build, type, syntax, logger, runtime-package,
      whitespace, and production-file-size gates.
- [x] Resolved all three Agent Deck follow-up issues and archived final records.

## Validation result

- Focused lead integration: 94 state/handoff tests, 114 runtime tests, 134 IPC/renderer tests,
  88 Browser-use tests, 12 skills-mirror tests, and 8 node_repl tests passed.
- Full Electron-ABI suite: 446 files passed and 1 skipped; 3,656 tests passed and 1 skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- `bash -n scripts/*.sh`, all CJS/MJS `node --check` runs, and `pnpm verify:bundled-runtimes`
  passed.

## Final status and handoff

Status: completed. All REVIEW_208 findings are fixed and tracked by `CHANGELOG_427` and
`REVIEW_209`. Native Linux/Windows and live-provider/Electron smoke boundaries are documented in
the final review. Main/preload behavior becomes active on the next normal Agent Deck launch; the
current collaboration host was intentionally not restarted. The worktree remains unstaged and
uncommitted.
