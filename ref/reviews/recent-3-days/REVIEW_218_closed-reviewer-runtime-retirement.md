---
review_id: 218
reviewed_at: 2026-08-09
baseline_commit: a2097eea4a84c3117a823da26f2a85d6908e9d32
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review rebucketing and bucket-index maintenance are mechanical records."
---

# REVIEW_218_closed-reviewer-runtime-retirement: Closed reviewer runtime retirement

## Scope and method

This issue-specific investigation reproduced the cleanup ownership chain from repeated
`shutdown_session` calls through adapter runtime retirement and `exit_worktree`'s live cwd fence.
It compared the desktop MCP handler with the Server Core collaboration path and preserved the
existing rule that a reported runtime cwd must continue to block deletion. This was an
implementation and self-review pass; neither `simple-review` nor `deep-review` was invoked.

```review-scope
src/hosts/server-core/mcp-session-collaboration.test.ts
src/hosts/server-core/mcp-session-collaboration.ts
src/main/adapters/closed-session-runtime-retirement.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
```

The concurrent dependency update in `package.json` / `pnpm-lock.yaml` and its changelog
maintenance were outside this Issue and were left untouched.

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Both shutdown surfaces returned `alreadyClosed=true` before invoking adapter cleanup. A naturally closed reviewer could therefore retain an in-memory cwd forever, while the correctly fail-closed worktree cleanup had no public recovery path short of restarting Agent Deck. | An already-closed shutdown now re-runs the owning adapter's idempotent close and succeeds only after `getRuntimeCwd` no longer reports that session. Desktop and Server Core use the same helper. |
| LOW | Reusing the full session lifecycle close would overwrite the original `endedAt` and repeat unrelated durable side effects. | The repair retires only adapter runtime state for an already-closed row; active targets keep the existing full close path, and `alreadyClosed` output semantics remain unchanged. |

No confirmed finding remains open.

## Validation and evidence

- Focused Electron-ABI regression coverage passed 2 files and 101 tests. It proves stale runtime
  cwd release, residual-cwd refusal, preserved closed history, active close behavior, and both
  desktop and Server Core routing.
- The full Electron-ABI suite passed 860 files and 5,612 tests; 3 environment-dependent tests were
  intentionally skipped.
- `pnpm typecheck` passed architecture boundaries, the 121-candidate Core Node boundary check, and
  both node and web TypeScript projects.
- `pnpm build` completed the production main, preload, and renderer bundles.
- `git diff --check` passed. Changed production files are 19, 76, and 290 lines; the only changed
  file over 500 lines is a test suite and therefore exempt from the production file-size guardrail.
- A direct system-Node test attempt encountered the documented Electron/Node
  `better-sqlite3` ABI mismatch; the required Electron runner then passed both focused suites and
  the complete suite without rebuilding or replacing the binding.

## Fixes landed

- Added a shared, host-neutral closed-session runtime retirement helper.
- Repeated desktop `shutdown_session` calls now retire stale adapter state instead of returning a
  no-op success.
- Server Core applies the same behavior without rewriting the closed session's historical end
  timestamp.
- A residual runtime cwd remains an explicit error, so `exit_worktree` never weakens its deletion
  fence.

## Residual risk

- The currently running installed Agent Deck process was not restarted because it owns this live
  delivery session. The source fix takes effect after the next normal rebuild/restart.
- This repair relies on each adapter's existing idempotent `closeSession` contract. The independent
  post-close cwd check prevents worktree cleanup from treating an adapter that still reports the
  old path as retired.
- No database schema or MCP result shape changed.

## Final verdict

PASS. Closed reviewer runtime cwd references now have a public, history-preserving retirement path,
and unretired references continue to fail closed.
