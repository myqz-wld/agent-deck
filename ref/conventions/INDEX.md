# Conventions Index

Project-specific convention records live here under `ref/`, alongside `ref/changelogs/`, `ref/reviews/`, and `ref/plans/`.

Purpose: keep entry instructions stable while repeated feedback, recurring mistakes, and reviewed conventions accumulate as separate records.

Promotion flow: record candidates in `tally.md`; when `count >= 3`, run the configured review/decision process, create `<X>-<topic>.md`, add a row here, and remove the promoted tally candidate.

## Promoted Conventions

Each `.md` record is one promoted project convention. Before changing related code, list `ref/conventions/` and read relevant records so existing decisions are not silently reversed.

| File | Topic | Promoted Date | Related Changelog | Related Review |
|---|---|---|---|---|
| _No promoted conventions yet._ | — | — | — | — |

## Candidate Status

See [tally.md](tally.md) for user-feedback and agent-pitfall candidates.

## Entry Relationship

Project `CLAUDE.md` keeps high-frequency invariants and workflow rules. New reusable project conventions are recorded in this directory and registered in this index.

The historical `CLAUDE.md` project-specific conventions section remains the pre-directory accumulation point. New promotions go to this directory; migrate historical items by topic the next time they are touched instead of running a dedicated split-only pass.
