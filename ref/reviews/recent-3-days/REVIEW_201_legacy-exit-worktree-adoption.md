---
review_id: 201
reviewed_at: 2026-07-30
baseline_commit: e1b543fd7bf28f15c57a740745a5bfceb55df4af
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review records and bucket-index maintenance are mechanical archive work."
---

# REVIEW_201_legacy-exit-worktree-adoption: Bounded legacy worktree exit

## Scope and method

Investigated the reproducible 1,800-second `exit_worktree` timeout against the pre-v059
marker-only path, correlated the absence of any handler Git child with the old pre-Git filesystem
awaits, and reviewed the replacement from MCP handler entry through durable adoption, exact tool
result observation, cwd restoration, cleanup, failure compensation, and startup recovery.

```review-scope
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
resources/grok-config/GROK_AGENTS.md
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.handler.test.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.test.ts
src/main/agent-deck-mcp/__tests__/worktree-contract-drift.test.ts
src/main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps.ts
src/main/agent-deck-mcp/tools/handlers/exit-worktree-impl.ts
src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/session/worktree-transition/__tests__/recovery.test.ts
src/main/session/worktree-transition/constants.ts
src/main/session/worktree-transition/git-cleanup.ts
src/main/session/worktree-transition/recovery.ts
src/main/session/worktree-transition/types.ts
src/main/store/__tests__/v059-worktree-cwd-transitions.test.ts
src/main/store/worktree-transition-legacy-adoption.ts
src/main/store/worktree-transition-repo.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The legacy path performed asynchronous filesystem metadata waits before the first Git child and then ran worktree removal inline in the lifecycle HTTP request. Production had no bound or handler-stage signal, so a pre-Git stall survived until the 1,800-second client timeout. The evidence is consistent with an async filesystem-pool wait, although the historical runtime cannot prove the exact pool occupant. | Replace legacy removal with synchronous local path metadata, immediate lexical rejection for a mismatched marker/path, 30-second Git preflight bounds, durable adoption into the existing restore-first transition, and `waiting-tool-result` acceptance. Existing worktrees are removed only after provider observation and confirmed cwd restoration. |
| MEDIUM | A detached legacy worktree has no branch name, while the asynchronous success schema required a non-empty branch. | Persist an empty internal branch projection, expose `workBranch: null`, skip branch deletion, and cover the detached contract with unit, handler, schema, database, and real-Git tests. |
| MEDIUM | If adapter arming failed or the application restarted before observing the adopted tool result, treating the record as a normal active lease could misrepresent a marker-only session's current cwd. | Give adopted exits a durable continuation discriminator and transactionally release an unacknowledged adoption back to marker-only compatibility without changing cwd, marker, Git state, or user files. |
| MEDIUM | Existing structured cleanup Git commands were unbounded, and production logs could not distinguish handler entry/preflight/adoption/arming from MCP dispatch. | Bound structured checks and branch operations to 30 seconds, worktree removal to 10 minutes, and emit a fixed-data slow-handler diagnostic after five seconds with the current handler stage and elapsed time. |
| LOW | Structured preflight did not reject an attached lease that had changed to detached HEAD because it compared only truthy branch names. | Compare the nullable actual and expected branch projections exactly before accepting exit. |

## Prompt-asset controls

- User Custom Point applied: resource instructions remain runtime-focused and do not mention
  repository maintenance formats or migrated asset names.
- Confirmed scope: the `exit_worktree` tool description, exit argument/output schema, and bundled
  Claude, Codex, and Grok worktree instructions.
- Inventory:
  `.prompt-asset-improver/local/inventory.json`, scanned
  `2026-07-30T18:15:13Z`, expires `2026-08-06T18:15:13Z`.
- Byte-identical pre-edit backup:
  `.prompt-asset-improver/local/backups/20260730T181513Z/`.
- The manifest originals retained their recorded SHA-256 values; the inventory was refreshed to
  the five post-edit SHA-256 values and both JSON documents parse successfully.
- The contract-drift test proves Claude/Codex parity, Grok automatic-cwd wording, detached nullable
  output, legacy adoption, and the already-absent `completed-legacy` boundary.

## Validation and evidence

- A real temporary Git repository test creates a clean detached registered worktree, runs the
  production default bounded preflight, and proves the directory and registration remain intact.
- Focused transition suite: 5 files and 35 tests passed after the final path-mismatch change.
- Full Electron-ABI suite: 492 files and 4,114 tests passed; one file and one test intentionally
  skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, `git diff --check`, and
  `bash scripts/file-level-review-expiry.sh` passed.
- All changed production TypeScript files remain at or below 500 lines.

## Fixes landed

- Existing marker-only or explicitly named registered worktrees now receive read-only preflight and
  durable structured adoption instead of synchronous removal.
- Missing targets still complete synchronously, clear a held stale marker, and report
  `completed-legacy` without claiming removal.
- Dirty-state refusal, reference fencing, second-check cleanup, branch preservation, explicit
  `discardChanges`, and explicit `deleteBranch` authorization remain intact.
- Five-second stage diagnostics make any future slow request attributable to handler entry,
  structured preflight, cleanup retry, legacy preflight/adoption, or transition arming.

## Residual risk

- Main-process code requires an Agent Deck restart. Restarting the installed application from this
  implementation session would terminate the session itself, so validation used the production
  build plus deterministic Electron-ABI and real-Git tests rather than mutating the currently
  running installation.
- Synchronous metadata calls remove dependence on the shared asynchronous filesystem pool, but an
  operating-system-level stall on a pathological filesystem mount cannot be time-bounded from the
  main process. The reported target is a responsive local registered worktree, and every Git
  command after metadata resolution is bounded.
- The preserved orphan worktree from the historical incident is intentionally not removed by this
  source change. It can be retried through `exit_worktree` after the updated main process is
  installed and restarted.
