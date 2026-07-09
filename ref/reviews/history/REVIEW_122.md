# REVIEW_122 — Codex no-op file changes shown in SessionDetail

- Trigger: user report that Codex-side file changes are inaccurate and sometimes show files that were not changed.
- Scope: Codex app-server file-change translation, file-change repository listing, shared unified-diff based no-op detection, and focused tests.
- Method: source trace plus targeted tests. No adversarial reviewer pair was spawned because the fix is narrow and covered at the translation, shared-helper, and repo-list boundaries.
- Related changelog: [CHANGELOG_285.md](../../changelogs/history/CHANGELOG_285.md).

## Decisions

1. **MED fixed: Codex `fileChange` items were trusted without checking patch status or effective diff**
   - Evidence: `translateCodexAppServerNotification` emitted a `file-changed` event for every `item.changes[]` path, even when `item.status` was failed or the diff was empty / header-only / before-after identical.
   - Fix: add `isIncompleteCodexFileChangeStatus` and `isEffectiveCodexFileChange`, then skip no-op Codex changes at translation time.

2. **MED fixed: historical no-op rows would still appear after a code fix**
   - Evidence: SessionDetail reads `fileChangeRepo.listForSession`, so already-persisted no-op rows would remain visible if filtering only happened in the translator.
   - Fix: apply the same Codex no-op policy in `fileChangeRepo.listForSession` for text rows whose metadata source is `codex`.

3. **LOW guarded: non-text real changes must not be dropped just because hunks are absent**
   - Evidence: binary diffs, renames, copies, and mode changes can be real without parseable `@@` hunks.
   - Fix: preserve explicit non-text diff signals while filtering update-like records that have no effective content delta.

## Validation

- `pnpm exec vitest run src/shared/__tests__/codex-file-change.test.ts src/main/store/__tests__/file-change-repo.test.ts src/main/adapters/codex-cli/app-server/translate.test.ts src/main/session/__tests__/file-change-snapshots.test.ts src/main/session/__tests__/final-file-diff.test.ts` passed: 29 tests.
- `pnpm typecheck` passed.

## Residual Risk

- If Codex introduces a new real-change kind without diff text or recognized non-text diff headers, update `@shared/codex-file-change` with that signal. Unknown update-like records with no effective diff are intentionally hidden to avoid false file-change display.
