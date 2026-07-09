# Plans Index

## Scope

Routing index for final plan documents. Only final plan documents enter `ref/plans/`. Keep non-final plans in the current environment's plan workspace; if no stronger contract exists, use `<repo>/.ref/plans/`. Add `.ref/` to `.gitignore`. Archive durable support materials meant for future agents somewhere under `ref/` and link them back to the plan; keep unarchived support materials in `.ref/`.

This root index defines routing and bucket policy only. Per-record plan rows live only in the bucket `INDEX.md` files.

## Naming

Final plans use `ref/plans/<bucket>/PLAN_X_<topic>.md`. Before creating one, scan `ref/plans/*/PLAN_*.md`, set `X` to the maximum existing plan number plus 1, and do not guess. `<topic>` is short stable kebab-case and must not be vague like `update`, `fix`, or `misc`.

## File Structure

- Goal
- Context / constraints
- Task breakdown
- Validation
- Completed date as `Completed At: <YYYY-MM-DD>` or frontmatter `completed_at`
- Final status / handoff

## Legacy Migration

Plans archived before this structure use topic-and-date basenames instead of `PLAN_X_<topic>.md`; keep those names stable. Current numbered plan records therefore begin at `PLAN_1`. Existing nonterminal plans are retained in `history` as legacy snapshots, not as active workspace plans. Legacy support directories remain beside their related records.

## Buckets

Buckets are mutually exclusive. Store each plan in exactly one bucket based on `Completed At` or `completed_at`.

| Bucket | Date Range | Directory |
|---|---|---|
| Recent 3 days | `Completed At` or `completed_at` is within the last 3 days, inclusive | `ref/plans/recent-3-days/` |
| Recent week | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive | `ref/plans/recent-week/` |
| Recent month | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive | `ref/plans/recent-month/` |
| History | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date | `ref/plans/history/` |

## Rebucket Rules

On every new or edited final plan:

1. Scan all `ref/plans/*/PLAN_*.md` files and preserved legacy plan records.
2. Recompute each file's bucket from `Completed At` or `completed_at`.
3. Move files that no longer belong in their current bucket.
4. Update this routing index only if bucket policy changes.
5. Update every affected bucket `INDEX.md` while preserving its table format.

For full recent-week context, read `recent-3-days/` plus `recent-week/`. For full recent-month context, read `recent-3-days/`, `recent-week/`, and `recent-month/`. For full history, read all four buckets.

## Bucket Indexes

- `ref/plans/recent-3-days/INDEX.md`
- `ref/plans/recent-week/INDEX.md`
- `ref/plans/recent-month/INDEX.md`
- `ref/plans/history/INDEX.md`
