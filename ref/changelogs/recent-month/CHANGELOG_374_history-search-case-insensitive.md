---
changelog_id: 374
changed_at: 2026-07-15
---

# CHANGELOG_374_history-search-case-insensitive: Unify History search casing

## Summary

History title, cwd, event, and summary search is now uniformly ASCII case-insensitive. The bounded
event projection is unchanged: tool output longer than 4,096 characters still indexes only its first
and last 2,048 characters.

## Schema and query behavior

- Added migration v43 and advanced the normal migration chain to `user_version = 43`.
- Rebuilt `event_search_fts_v1` and `summaries_fts` with
  `tokenize='trigram case_sensitive 0'` and recreated their insert, update, and delete triggers.
- Fully repopulated bounded event search from `event_search_source_v1` and summary search from the
  business table without changing event, session, summary, or rowid relationships.
- Removed the optional legacy raw-payload `events_fts` table and its triggers.
- Forced `event-search-v1` maintenance state to `complete`, preventing older backfill or shutdown
  retirement phases from touching the v43 index.
- Kept the two-character threshold: shorter keywords search title and cwd only.

## Offline migration

- Added `pnpm migrate:history-search -- --db <observed-path>` using Electron's production SQLite
  runtime. The command requires an explicit observed database path and refuses active Agent Deck
  processes, open database handles, an unavailable exclusive write lock, or insufficient disk.
- The tool backs up to a sibling candidate, migrates and validates that copy, then atomically renames
  the original to a timestamped `.bak` and the candidate into place.
- Validation compares business-table row counts, both FTS rowid sets, event and summary case variants,
  the short-keyword boundary, trigger insert/update/delete behavior, quick/FK checks, and both FTS
  integrity checks.
- Finalization requires a second fully stopped run with `--smoke-passed`; it revalidates v43 before
  deleting the named backup.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 313 files and 2,860 tests; one opt-in live smoke remained skipped.
- `pnpm build` and `pnpm test:fts5` passed.
- A temporary v42 file database passed the complete migrate, atomic switch, and finalize workflow.
- The 2.3GB production database was copied, migrated, validated, and switched offline. After the app
  smoke and subsequent writes it contained 838 sessions, 228,401 events, and 6,700 summaries; both
  FTS row counts matched their sources, `quick_check` was `ok`, `foreign_key_check` was empty, and
  `events_fts` was absent.
- The real History page returned the same row for lowercase, uppercase, and mixed-case variants of an
  event-only marker and a summary marker. The timestamped rollback backup was deleted only after that
  smoke passed and the app was stopped again.

## Do Not Split Protection

No changed first-party source file exceeds 500 lines. The offline migration implementation is 379
lines, and the existing `core-crud.ts` remains exactly 500 lines.
