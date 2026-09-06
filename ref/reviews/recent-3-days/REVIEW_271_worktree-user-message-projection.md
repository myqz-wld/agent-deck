---
review_id: 271
reviewed_at: 2026-09-06
baseline_commit: ead7a99655036eca11a74cc30793226ce3036f0f
expired: false
---

# Worktree user-message continuity and requested documentation cleanup

## Scope and method

Trace ordinary sends from IPC through the shared transition ingress, adapter event sink, and
post-switch replay. Add deterministic regressions before repairing the confirmed failures, then
verify all three adapter ingress paths and Codex continuation ordering. This is a debugging and
self-review pass; no independent reviewer sessions were requested or used.

The user also requested a shorter `README.md` and explicitly authorized deleting the entire
`.prompt-asset-improver` directory. These changes are included in the final scope.

```review-scope
.gitignore
.prompt-asset-improver/shared/custom-points.md
README.md
src/main/adapters/claude-code/sdk-bridge/message-controller-core.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host-core.ts
src/main/adapters/grok-build/bridge-runtime-core.ts
src/main/adapters/grok-build/message-controller.ts
src/main/session/hand-off/ingress-guard.ts
src/main/session/worktree-transition/coordinator.ts
src/main/session/worktree-transition/ingress-guard.ts
src/main/session/worktree-transition/__tests__/buffered-input-continuity.test.ts
src/main/session/worktree-transition/__tests__/coordinator-observe.test.ts
src/main/session/worktree-transition/__tests__/ingress-guard.test.ts
```

## Findings and fixes

| Severity | Evidence | Resolution |
|---|---|---|
| HIGH | During `interrupting_enter_turn` and `interrupting_exit_turn`, the coordinator rejected every SDK `message` event, including user acknowledgements emitted after durable buffer acceptance. Replay subsequently suppressed their history events as already persisted. | Retain adapter-owned user messages through the interruption fence. Continue rejecting late assistant messages and tool starts. |
| MEDIUM | Ordinary IPC sends provided `turnCorrelationId`, but every adapter's ingress boundary discarded it before buffered-message projection. The renderer could not correlate that acknowledgement to the outgoing message. | Forward the optional id through Claude, Codex, Grok, and the shared worktree guard into the accepted user event. |

The existing durable buffering, immediate history projection, FIFO replay, fixed continuation,
and atomic drain-and-seal mechanisms remain intact. The repair changes neither native provider
protocols nor the database schema.

## User custom points and prompt-asset audit

- The active project preference requires explicit user approval before changing a running Agent
  Deck process or installed application. It remains in `CLAUDE.md` and `AGENTS.md`.
- The user explicitly named `README.md` for simplification. Compress highlights, setup, runtime
  configuration, remote deployment, and development guidance; remove pinned versions, model
  defaults, status-copy details, and the internal directory taxonomy. Keep authentication,
  permission boundaries, Browser privacy, deployment prerequisites, and detailed-document links.
- README now contains 78 lines, down from 141. Bundled runtime conventions and adapter-specific
  resource contracts were checked as context and left unchanged.
- Refresh the seven-day local inventory, back up README under
  `.prompt-asset-improver/local/backups/20260906T153954Z/`, verify the manifest and original SHA-256,
  and refresh the changed asset hash after validation. All completed before cleanup.
- The user's later directory-deletion instruction supersedes keeping those maintenance records.
  Remove all 297 files in `.prompt-asset-improver`, including ignored backups, inventory, and
  custom points, plus its stale ignore rule and comment. No maintenance directory is recreated.
  The original tracked README remains inspectable with `git show` at the baseline commit.
- Direct user authorization covers both the reversible README edit and the subsequent directory
  deletion; no additional skill approval gate was introduced. No one-time direction was stored as
  a standing preference. No external links were added or required verification.

## Validation

- The new enter/exit fence regressions failed before the repair; the outgoing-id regression
  independently reproduced the missing correlation field.
- Focused continuity coverage: 13 tests passed across coordinator observation, ingress, and the
  combined adapter/buffering/replay path. Tests retain attachments and verify exactly one history
  acknowledgement, continuation-first queue ordering, target cwd, and release after draining.
- `pnpm typecheck` passed, including both architecture checks.
- `pnpm test`: 1,026 files and 6,354 tests passed; two files and three tests intentionally skipped.
- After the README edit, the four bundled Browser documentation tests passed. All 11 README
  relative links resolve and all nine mentioned pnpm commands exist.
- `pnpm build` passed. The Electron-compatible test entrypoint preserved the SQLite native binding;
  its checksum is unchanged before and after the full suite.
- The repository review-expiry scan and `git diff --check` passed. All changed source files are
  below the 500-line guardrail.
- Rebucket the August 6 Linux foundation plan into history without changing its content; update
  its affected indexes and archive this task as `PLAN_51_worktree-user-message-projection.md`.

## Residual risk and handoff

- No credentialed live provider transition was performed. Deterministic tests establish the
  confirmed event-loss path, adapter correlation forwarding, and queue ordering.
- The running installed Agent Deck application was inspected read-only and left running. Source
  bundles are built, but the installed app has not been replaced. Loading the fix in that instance
  requires an updated installation and restart, with explicit approval before any process or
  installed-bundle action.
- Previously omitted history events are not reconstructed by this repair.
