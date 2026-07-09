# Changelogs Index

## Scope

Routing index for final changelog records. Final changelogs document user-visible features, behavior changes, API changes, dependency upgrades, and project setup changes. Debug, performance, security, and review-driven fixes go in `ref/reviews/`.

This root index defines routing and bucket policy only. Per-record changelog rows live only in the bucket `INDEX.md` files.

## Naming

Final changelogs use `ref/changelogs/<bucket>/CHANGELOG_X_<topic>.md`. Before creating one, scan `ref/changelogs/*/CHANGELOG_*.md`, set `X` to the maximum existing changelog number plus 1, and do not guess. `<topic>` is short stable kebab-case and must not be vague like `update`, `fix`, or `misc`.

## File Structure

- Frontmatter with `changelog_id` and `changed_at`
- Summary
- Changes grouped by module or layer
- Validation
- Do Not Split Protection
- Notes, related review, or omitted rationale

## Legacy Migration

`CHANGELOG_1.md` through `CHANGELOG_348.md` predate this structure. Their basenames and contents remain unchanged, and missing authoritative `changed_at` values route them to `history`. New records use the current naming and frontmatter format.

## Buckets

Buckets are mutually exclusive. Store each changelog in exactly one bucket based on `changed_at`.

| Bucket | Date Range | Directory |
|---|---|---|
| Recent 3 days | `changed_at` is within the last 3 days, inclusive | `ref/changelogs/recent-3-days/` |
| Recent week | Older than 3 days and within the last 7 days, inclusive | `ref/changelogs/recent-week/` |
| Recent month | Older than 7 days and within the last 30 days, inclusive | `ref/changelogs/recent-month/` |
| History | Older than 30 days, or missing a parseable date | `ref/changelogs/history/` |

## Rebucket Rules

On every new or edited final changelog:

1. Scan all `ref/changelogs/*/CHANGELOG_*.md` files.
2. Recompute each file's bucket from `changed_at`.
3. Move files that no longer belong in their current bucket.
4. Update this routing index only if bucket policy changes.
5. Update every affected bucket `INDEX.md` while preserving its table format.

For full recent-week context, read `recent-3-days/` plus `recent-week/`. For full recent-month context, read `recent-3-days/`, `recent-week/`, and `recent-month/`. For full history, read all four buckets.

## Bucket Indexes

- `ref/changelogs/recent-3-days/INDEX.md`
- `ref/changelogs/recent-week/INDEX.md`
- `ref/changelogs/recent-month/INDEX.md`
- `ref/changelogs/history/INDEX.md`
