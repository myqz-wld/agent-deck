---
review_id: 149
reviewed_at: 2026-07-11
baseline_commit: 93d7048f1f324c9ea5f89db75b40a21d40581d20
expired: false
skipped_expired: []
---

# REVIEW_149_session-pinning-reviewer-model: Session pinning and Codex reviewer runtime

## Scope

The reviewer inspected the complete staged post-baseline implementation: the one approved prompt
asset, v039, pin persistence and projection, lifecycle/retention race guards, terminal cleanup,
manager/IPC/preload integration, Live renderer controls and ordering, focused tests, README, and
prompt inventory.

```review-scope
.prompt-asset-improver/inventory.json
README.md
resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml
src/main/__tests__/_shared/mocks/session-repo.ts
src/main/codex-config/__tests__/bundled-reviewer-runtime.test.ts
src/main/ipc/__tests__/sessions-pin.test.ts
src/main/ipc/_helpers.ts
src/main/ipc/sessions.ts
src/main/session/__tests__/lifecycle-scheduler.test.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/__tests__/manager-test-setup.ts
src/main/session/lifecycle-scheduler.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/session/manager/lifecycle.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/v039-migration.test.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v039_sessions_pinned.sql
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/__tests__/archive.test.ts
src/main/store/session-repo/__tests__/pin-lifecycle.test.ts
src/main/store/session-repo/archive.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/index.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/pinning.ts
src/main/store/session-repo/rename.ts
src/main/store/session-repo/types.ts
src/preload/api/sessions.ts
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionPinButton.tsx
src/renderer/components/__tests__/SessionPinButton.test.tsx
src/renderer/lib/__tests__/session-selectors.test.ts
src/renderer/lib/session-selectors.ts
src/shared/ipc-channels.ts
src/shared/types/session.ts
```

## Review Mode and Method

The user explicitly requested one standalone `reviewer-codex` rather than the skills' normal
two-reviewer orchestration. Agent Deck spawned session
`019f50b4-0037-7732-b7b8-7a2b19131551` with model `gpt-5.6-sol`, thinking `xhigh`, and a read-only
sandbox.

The reviewer read the approved durable plan and repository instructions, inspected the complete
staged diff from baseline `93d7048f1f324c9ea5f89db75b40a21d40581d20`, traced SQLite and renderer
callers across file boundaries, and performed a follow-up review of the only material finding.

## Gate Result

Final result: **APPROVE** under the user's explicit single-reviewer override.

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 1 fixed
- Remaining CRITICAL/HIGH/material MEDIUM: 0

## Finding and Resolution

### MEDIUM fixed: a pinned descendant could outlive its structural owner at the capacity boundary

The first Live query raised its flat limit only to `max(limit, pinnedCount)`. With more than 100 live
rows, an old unpinned spawn owner or universal-team lead could be omitted while its pinned child was
retained, causing the renderer to promote the child to a root.

The fixed query keeps the all-pinned-plus-recency seed and recursively adds every still-live spawn
ancestor plus all active live lead sessions for selected teammate memberships. The query runs with
the pin count in one better-sqlite3 transaction, uses `UNION` to terminate cycles, and preserves
stable pinned/recency/id ordering. A >100-row regression covers a pinned child, two old ancestry
levels, and an old team lead; the 100-row seed correctly expands to 103.

The same reviewer re-ran the CTE shape against an in-memory fixture, traced the result through
manager team enrichment and `session-list-tree`, and marked the finding RESOLVED.

## Validation and Evidence

- Final full suite: 250 files / 2,413 tests passed.
- Focused post-fix gate: 4 files / 35 tests passed.
- v039 migration upgrade/fresh-schema/constraint/index/EXPLAIN gate: 5/5 passed.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, staged/unstaged diff checks, prompt validators,
  changed-production-file size checks, and review-expiry inventory passed.
- `src/main/store/session-repo/core-crud.ts` remains 492 lines; `src/main/session/manager.ts` remains
  499 lines.
- The reviewer made no file edits.

## Residual Risk

- The user deliberately selected a single Codex reviewer, so this gate does not claim heterogeneous
  provider review.
- Interactive verification of the new main/preload/schema path requires a later safe app restart.
  The running app was not restarted because it owns active sessions.

## Related Records

- [CHANGELOG_359](../../changelogs/recent-month/CHANGELOG_359_session-pinning-reviewer-model.md)
- [PLAN_4](../../plans/recent-month/PLAN_4_session-pinning-reviewer-model.md)
