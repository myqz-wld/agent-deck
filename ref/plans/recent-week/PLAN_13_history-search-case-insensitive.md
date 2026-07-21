---
plan_id: PLAN_13
title: Offline case-insensitive History FTS migration
status: completed
created_at: 2026-07-15
updated_at: 2026-07-15
completed_at: 2026-07-15
base_branch: main
base_commit: 4167383fda03c07e86b2bd10fa5bdd7edfd5ae5a
related_changelog: CHANGELOG_374
---

# PLAN_13_history-search-case-insensitive: Rebuild History FTS offline

## Goal and invariants

- Make title, cwd, event, and summary History search uniformly ASCII case-insensitive.
- Keep the bounded event projection and its 2,048-character head/tail limits unchanged.
- Never migrate the live production database in place or while Agent Deck has an active writer.
- Preserve all business tables and row relationships, keep the original until UI smoke succeeds, and
  stop without switching whenever copy validation fails.

## Confirmed decisions

- Use the next formal schema migration, v43; do not rewrite released migrations.
- Recreate bounded event and summary FTS with `trigram case_sensitive 0`.
- Converge every v41 maintenance phase to `complete` and remove the obsolete raw-payload FTS.
- Run one offline full copy/rebuild instead of background progressive backfill.
- Require an explicit database path observed from the running app and at least 5GiB free space.

## Completed checklist

- [x] Read project and Codex runtime instructions and inspect the production database's live handles.
- [x] Quit Agent Deck and verify that the app, helpers, database, WAL, and SHM had no open handles.
- [x] Add v43 schema, triggers, maintenance cutover, query comments, and regression tests.
- [x] Add the copy-first offline migrate/swap/finalize command and document its operator flow.
- [x] Cover case variants, bounded output, rowid sets, short keywords, triggers, integrity, and cutover.
- [x] Pass focused tests, full typecheck/test/build, and the legacy FTS harness.
- [x] Migrate and validate the 2.3GB production database, retaining the original rollback copy.
- [x] Run real History UI event and summary case-variant smoke tests.
- [x] Stop the app, revalidate v43, and delete the named rollback backup.

## Validation and completion

The formal migration, offline operator path, full automated suite, production copy validation, atomic
cutover, real History UI smoke, and guarded backup cleanup all completed successfully. The resulting
database is at `user_version = 43`; bounded and summary FTS row counts match their source tables, the
legacy raw-payload FTS is absent, and maintenance state cannot re-enter an older cutover phase.
