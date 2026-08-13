---
changelog_id: 437
changed_at: 2026-08-05
---

# CHANGELOG_437_authoritative-database-host-boundary: Inject the Core database host

## Summary

The first post-P3 Core-extraction slice removes Electron-owned path and logging access from the
authoritative SQLite entry. Desktop startup now supplies the exact database path and diagnostics
port explicitly, while a real Node 22 bundle gate prevents the candidate persistence boundary from
regaining Electron dependencies.

## Persistence host boundary

- Changed database initialization to require a bounded absolute host path and an explicit
  diagnostics port. The persistence layer no longer reads `app.getPath`, imports Electron, imports
  `electron-log`, or derives a path from process cwd.
- Bound a live database instance to one normalized host path until close, preventing another
  topology or instance from silently reusing the singleton for a different path.
- Kept schema inspection, fingerprinting, WAL, foreign-key, trusted-schema, fail-closed version,
  shutdown, and cleanup behavior unchanged. Diagnostics failures remain best-effort and cannot
  replace persistence outcomes.
- Updated Electron bootstrap to adapt its `userData` path and scoped logger into the explicit host
  contract; renderer and user-visible database behavior are unchanged.

## Node boundary gate

- Extended the static architecture checker so individual Core-candidate files can have dedicated
  forbidden-import rules.
- Added `check-core-node-boundaries.mjs`, which performs an in-memory Node 22 SSR bundle of each
  published Core candidate and fails on direct or transitive `electron` / `electron-log` imports.
  `pnpm check:architecture` now runs both the static dependency rules and this executable bundle
  proof.

## Validation

- `mise exec -- pnpm typecheck`: passed, including the static and Node bundle boundaries.
- `mise exec -- pnpm build`: passed for the Electron main, preload, and renderer production bundles.
- `mise exec -- pnpm test -- --reporter=dot`: 605 files passed plus 1 skipped; 4,723 tests
  passed plus 1 skipped.
- Focused database/bootstrap suite: 3 files and 11 tests passed under the canonical Electron runner.
- The database-only Node 22 SSR bundle completed with `better-sqlite3` kept as the declared native
  external and no Electron dependency observed.
- `git diff --check`, changelog ID/bucket validation, and the changed-file 500-line guard passed.

## Do Not Split Protection

Keep the explicit host path/diagnostics contract and the executable Node boundary gate together.
Accepting host injection without the transitive bundle proof would allow an Electron dependency to
re-enter through a helper while the direct-import rule remains green.

## Remaining boundary

This slice only makes the existing persistence entry reusable by a Node host. Provider adapters,
resource resolution, worker modules, Browser, and the complete concrete Server Core / local Worker
runtime are still being extracted and are not claimed as deployable.

The shared development Electron process was not restarted because the operator explicitly required
that no shared process be killed or replaced during this work.
