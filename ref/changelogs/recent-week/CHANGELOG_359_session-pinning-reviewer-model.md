---
changelog_id: 359
changed_at: 2026-07-11
---

# CHANGELOG_359_session-pinning-reviewer-model: Pin live sessions and update Codex reviewer runtime

## Summary

The Live page now supports persistent session pins. Pinned sessions sort first, survive the live-list
capacity boundary together with the structural owners needed by the tree, and cannot be moved to
dormant/closed or deleted by automatic lifecycle and retention jobs. The bundled Codex reviewer
fallback now uses `gpt-5.6-sol` with its existing `xhigh` reasoning setting.

## Changes

### Reviewer runtime asset

- Replaced only the bundled `reviewer-codex.toml` fallback model from `gpt-5.5` to
  `gpt-5.6-sol`; `model_reasoning_effort = "xhigh"` is unchanged.
- Kept the paired `simple-review` and `deep-review` skill bodies unchanged, so reviewer selection,
  heterogeneous-slot rules, rebuttal flow, and Claude/Deepseek behavior remain intact.
- Refreshed the prompt-asset inventory, created a manifest-backed local backup, validated all four
  paired skill assets, and added a runtime contract test for the bundled agent resolution.

### Persistent pin state and live-list closure

- Added v039 with nullable, nonnegative `sessions.pinned_at` and partial indexes for automatic
  lifecycle scans, pinned-first live ordering, and retention cleanup.
- Added a dedicated pin mutation. Pinning a dormant session atomically reactivates it; closed and
  archived sessions reject pin requests; repeated pin calls preserve the first timestamp.
- Ordinary full-record upserts cannot overwrite pin state, and both rename paths preserve the source
  session's pin value.
- The Live query selects all pinned rows plus remaining recency slots, then recursively includes live
  spawn ancestors and universal-team lead parents required by the renderer tree. This closure may
  exceed 100 rows and uses cycle-deduplicating deterministic ordering.

### Lifecycle, retention, and terminal behavior

- Automatic active → dormant and dormant → closed writes now recheck source lifecycle, inactivity,
  archive state, and `pinned_at IS NULL` in the final SQL statement.
- Retention deletion similarly rechecks pin, age, and history predicates at the delete boundary.
- Deliberate archive, handoff finalization, shutdown/close, delete, and provider `session-end` remain
  allowed. Archive/close/session-end clear the pin in the same persistence transition.
- Session-manager list, mocks, fixtures, and migration-chain helpers now use the pin-aware APIs.

### IPC and Live UI

- Added strict `session:set-pinned` IPC validation and a typed preload API returning the committed
  `SessionRecord`.
- Added zh-CN `置顶会话` / `取消置顶会话` controls to Live cards and eligible detail headers.
- The renderer uses the existing committed `session-upserted` event bridge as source of truth, does
  not keep an optimistic local pin map, and blocks synchronous double clicks.
- Live ordering is stable by `pinnedAt DESC`, `lastEventAt DESC`, then session id while preserving
  spawn/team tree ownership.

## Validation

- Final full suite: 250 files / 2,413 tests passed.
- Final closure/migration/scheduler/tree gate: 4 files / 35 tests passed.
- Focused v039 migration gate: 5/5 tests passed.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, staged/unstaged diff checks,
  file-size checks, and `scripts/file-level-review-expiry.sh` passed.
- Four paired skill validators and the bundled reviewer-runtime contract test passed.
- One user-requested Codex `gpt-5.6-sol` / `xhigh` reviewer inspected the complete staged delta.
  Its one MEDIUM capacity/lineage finding was fixed and re-reviewed; final result was APPROVE with
  no remaining CRITICAL, HIGH, or material MEDIUM finding.

## Do Not Split Protection

- `src/main/session/__tests__/manager-ingest.test.ts` is a pre-existing integrated ingest-state
  harness and is now 907 lines. This change adds only the terminal-event pin-clear regression to its
  shared SDK/hook lifecycle fixture. Split the fixture when the ingest pipeline is next redesigned,
  so its claim/dedup/event-order setup is extracted once rather than duplicated for one assertion.

## Notes

- Main/preload/schema changes require a later safe application restart. The running Agent Deck app
  was not restarted or overwritten because it owns active sessions.
- After the user-requested commit/push, the reviewed commit chain was fast-forwarded to main and
  `origin/main`; redundant implementation worktrees and branches were removed only after remote
  equality verification. The prompt rollback backup remains under main's ignored local backup area.

## Related Records

- [REVIEW_149](../../reviews/recent-3-days/REVIEW_149_session-pinning-reviewer-model.md)
- [PLAN_4](../../plans/recent-3-days/PLAN_4_session-pinning-reviewer-model.md)
