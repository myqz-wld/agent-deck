---
changelog_id: 349
changed_at: 2026-07-09
---

# CHANGELOG_349_project-engineering-foundation: Align repository engineering foundation

## Summary

Aligned Agent Deck's durable repository structure with the current engineering-foundation templates. Historical records now use strict time buckets, retired reference areas are removed, and current helper scripts enforce the ongoing lifecycle without changing runtime behavior.

## Changes

### Repository workflow and documentation

- Reworked `CLAUDE.md` around the current directory, final-record, review-expiry, file-size, validation, and packaging contracts while preserving Agent Deck-specific boundaries.
- Updated `README.md` and `.gitignore` for the bucketed `ref/` layout, current helper names, and `.ref/` workspace lifecycle.
- Kept `AGENTS.md`, `UI_COPY_LANGUAGE.md`, and bundled Claude/Codex prompt assets unchanged after counterpart checks.

### Archived engineering records

- Added `recent-3-days`, `recent-week`, `recent-month`, and `history` buckets under changelogs, reviews, and plans.
- Migrated 348 changelogs, 143 reviews, 99 root-level legacy plans, one nested legacy plan, and their support directories without renaming legacy records or inventing metadata.
- Rebuilt root routing indexes and bucket indexes; repaired migration-affected relative links.
- Removed `ref/conventions/`, `ref/architecture/`, and `ref/flows/` at the user's direction while retaining historical prose about those former assets.

### Foundation automation

- Updated `scripts/file-level-review-expiry.sh` to read nested review buckets, authoritative `baseline_commit`, and `scope_unknown` coverage.
- Replaced the plan-only reminder with `scripts/ref-archive-reminder-pre-commit.sh` and refreshed its local pre-commit managed block.

## Validation

- Record, bucket, index, filename, sidecar, and summary-length invariants checked.
- Markdown links match the baseline's 45 known stale links; no new broken link was introduced.
- Shell syntax and both foundation helpers executed successfully.
- `pnpm typecheck`
- `pnpm test` — 190 files and 2110 tests passed.
- `pnpm build`

## Do Not Split Protection

None. No first-party source file changed.

## Notes

- Related plan: `PLAN_1_project-engineering-foundation.md`.
- Prompt/reference backup: `.prompt-asset-improver/local/backups/20260709T193920Z/` (local and ignored).
