---
plan_id: codex-file-change-accuracy-20260618
created_at: 2026-06-18
status: completed
base_commit: fdb9c55ccc692c392c3dcda8ec0d4e165d28cae7
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# Codex File Change Accuracy

## Goal

Fix Codex-side file-change reporting so the SessionDetail change list does not show files that have no effective content change.

## Invariants

- Recorded diffs stay session-scoped and independent of the current Git working tree.
- Claude-side tool-result file-change intent behavior is unchanged.
- Real Codex modifications, creates, deletes, renames, binary patches, and mode/rename diff signals remain visible.
- No-op filtering applies only when the Codex patch status or unified diff proves there is no effective change.

## Completed Work

- Added `@shared/codex-file-change` as the shared policy for Codex patch status and no-op diff detection.
- Filtered incomplete or no-op Codex `fileChange` app-server items before they emit `file-changed` events.
- Filtered historical no-op Codex rows in `fileChangeRepo.listForSession`, so existing polluted rows no longer show in the change tab.
- Preserved non-text diff signals such as binary diffs and renames that do not contain parseable hunks.
- Added focused tests for the shared helper, Codex app-server translation, and repo list filtering.

## Validation

- `pnpm exec vitest run src/shared/__tests__/codex-file-change.test.ts src/main/store/__tests__/file-change-repo.test.ts src/main/adapters/codex-cli/app-server/translate.test.ts src/main/session/__tests__/file-change-snapshots.test.ts src/main/session/__tests__/final-file-diff.test.ts` passed: 29 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed.

## Related Records

- [CHANGELOG_285.md](../../changelogs/history/CHANGELOG_285.md)
- [REVIEW_122.md](../../reviews/history/REVIEW_122.md)
