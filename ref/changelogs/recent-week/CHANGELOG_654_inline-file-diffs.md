---
changelog_id: 654
changed_at: 2026-09-29
---

# Inline File Changes and Shared Diff Presentation

## Summary

Open recorded file edits directly in activity rows and give Claude, Codex, and Grok the same
addition, deletion, and modification views in both activity and the Changes tab.

## Changes

- Activity rows provide **查看改动**, collapse, and **放大**, using the shared diff viewer and overlay.
  The Changes tab retains file history and final comparisons, with wrapping narrow-window controls.
- Persist a file change before its activity row, then store/broadcast a lightweight `fileChangeId`
  reference. Large text/patch content stays in file-change storage. Expansion reuses the existing
  session-bound payload API, without a file-list lookup, new IPC channel, or schema migration.
- Historical events still open their original content/patch directly. Local and Remote payload
  reads share a bounded cache, stale-response fencing, session/id validation, and retry behavior.
  Remote activity uses its source-owned reader and never falls back to Local payload/image APIs.
- Centralize payload conversion and text normalization. Complete snapshot pairs take precedence;
  one missing snapshot falls back to the recorded snippet/patch pair. Codex raw additions and
  deletions, including empty files and text containing patch examples, use whole-file colors and
  Chinese badges like other providers. Existing-file insertions remain modifications.
- Prefer exact Grok full texts and Codex whole-file content over later disk contents when saving
  snapshots, while preserving path authorization. Preserve unusual historical patch-status labels.
- Grok now collects diffs from initial calls, progress updates, and late content updates, emitting
  each file once after success. Keep the earliest before text and latest after text, drop failed
  or unfinished previous-turn intents, and bound completion history.

## Validation

- `pnpm typecheck` passed, including both architecture guards and TypeScript projects.
- Final full `pnpm test`: 1,062 files / 6,551 tests passed; 2 files / 3 opt-in tests skipped.
- Focused final regression batch: 7 files / 51 tests passed.
- Production main, preload, and renderer build passed. The Electron SQLite binding checksum
  remained unchanged; no dependencies or native bindings were rebuilt.
- Agent Deck Browser rendered the actual Changes tab and activity components with synthetic data.
  Claude/Codex/Grok additions and deletions had identical row content, line numbers, and computed
  colors; modifications used the same Monaco viewer. The 420px viewport had 420px page width.
  Screenshots checked inline expansion and enlargement; Escape closed the overlay. The row read
  count was zero before opening and one afterward. The test tab was closed.
- Whitespace, changed-file privacy, local links, source/test size, and record buckets were checked.

## Do Not Split Protection

None. Every changed source/test file is below 500 lines. Persistence, normalization, Grok capture,
activity rows, and the shared overlay have focused modules.

## Boundaries

Old truncated or absent provider content cannot be recovered. Historical comparisons never read
current file contents at view time. No app process, installed bundle, database schema, or provider
configuration was changed; the main-process changes require an approved runtime restart to activate.

- [Implementation inspection](../../reviews/recent-week/REVIEW_286_inline-file-diffs.md)
- [Completed plan](../../plans/recent-week/PLAN_62_inline-file-diffs.md)
