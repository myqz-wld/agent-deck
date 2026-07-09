# Reviews Index

## Scope

Routing index for final review records. Final reviews document debug work, code review, performance audit, security review, and review-driven fixes. Keep non-final review drafts and raw reviewer output in `<repo>/.ref/reviews/` or the current review workspace, and add `.ref/` to `.gitignore`. Feature changes go in `ref/changelogs/` unless they are debug, performance, security, or review-driven fixes.

This root index defines routing and bucket policy only. Per-record review rows live only in the bucket `INDEX.md` files.

## Naming

Final reviews use `ref/reviews/<bucket>/REVIEW_X_<topic>.md`. Before creating one, scan `ref/reviews/*/REVIEW_*.md`, set `X` to the maximum existing review number plus 1, and do not guess. `<topic>` is short stable kebab-case and must not be vague like `update`, `fix`, or `misc`.

## File Structure

- Frontmatter with `review_id`, `reviewed_at`, `baseline_commit`, and expiry fields
- Scope
- Findings
- Validation / evidence
- Fixes Landed
- Residual risk
- Follow-ups

## Legacy Migration

`REVIEW_1.md` through `REVIEW_143.md` predate the complete current format. Preserve their basenames and factual metadata. A missing `reviewed_at` routes a record to `history`; a missing usable `baseline_commit` or `review-scope` makes its coverage `scope_unknown` rather than exempting files from review.

## Buckets

Buckets are mutually exclusive. Store each review in exactly one bucket based on `reviewed_at`.

| Bucket | Date Range | Directory |
|---|---|---|
| Recent 3 days | `reviewed_at` is within the last 3 days, inclusive | `ref/reviews/recent-3-days/` |
| Recent week | Older than 3 days and within the last 7 days, inclusive | `ref/reviews/recent-week/` |
| Recent month | Older than 7 days and within the last 30 days, inclusive | `ref/reviews/recent-month/` |
| History | Older than 30 days, or missing a parseable date | `ref/reviews/history/` |

## Rebucket Rules

On every new or edited final review:

1. Scan all `ref/reviews/*/REVIEW_*.md` files.
2. Recompute each file's bucket from `reviewed_at`.
3. Move files that no longer belong in their current bucket.
4. Update this routing index only if bucket policy changes.
5. Update every affected bucket `INDEX.md` while preserving its table format.

For full recent-week context, read `recent-3-days/` plus `recent-week/`. For full recent-month context, read `recent-3-days/`, `recent-week/`, and `recent-month/`. For full history, read all four buckets.

## Bucket Indexes

- `ref/reviews/recent-3-days/INDEX.md`
- `ref/reviews/recent-week/INDEX.md`
- `ref/reviews/recent-month/INDEX.md`
- `ref/reviews/history/INDEX.md`
