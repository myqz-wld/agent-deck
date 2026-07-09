---
plan_id: PLAN_1
created_at: 2026-07-09
completed_at: 2026-07-09
status: completed
related_changelog: CHANGELOG_349
---

# PLAN_1_project-engineering-foundation: Align Repository Engineering Foundation

## Goal

Repair the mature Agent Deck repository so its durable engineering structure tracks the current `project-engineering-foundation` templates without changing application runtime behavior.

## Invariants

- Preserve Agent Deck-specific build, validation, packaging, adapter, and bundled-resource rules.
- Preserve legacy record basenames and factual content; do not invent dates, review baselines, severity, or completion state.
- Keep bundled Claude and Codex runtime prompts free of current-repository maintenance formats.
- Do not reorganize `src/`, split unrelated legacy files, or revive the retired public `archive_plan` workflow.

## Decisions

- Use a minimal repair for the mature repository while aligning durable structure and wording closely with the current templates.
- Delete `ref/conventions/`, `ref/architecture/`, and `ref/flows/` after the user explicitly retired each area.
- Route final changelogs, reviews, and plans through four mutually exclusive date buckets.
- Preserve legacy changelog, review, and plan names. New numbered plan records start at `PLAN_1`; new changelogs continue from `CHANGELOG_349`.
- Put records with missing authoritative dates in `history` instead of inferring dates from body text, filenames, Git history, or filesystem metadata.
- Keep nonterminal legacy plans as historical snapshots and co-move sidecar directories with their records.

## Completed Work

- Reorganized 348 changelogs, 143 reviews, 99 root-level legacy plans, one nested legacy plan, and their durable sidecars into strict buckets.
- Rebuilt routing and bucket indexes, including six review records omitted by the old index.
- Repaired relative links affected by the added bucket depth and converted two links to the retired flow set into historical path notes.
- Aligned `CLAUDE.md`, `README.md`, and `.gitignore` with the current foundation layout and lifecycle.
- Replaced the flat review-expiry and plan-only reminder helpers with the current nested review-expiry and `.ref` archive helpers.
- Refreshed the local pre-commit hook while preserving unrelated hook content.

## Validation

- Record counts, ID continuity, bucket exclusivity, root-directory emptiness, sidecar placement, and index coverage checked.
- Markdown link check has the same 45 pre-existing stale links as baseline `47eb596`; migration introduced none.
- `bash -n scripts/file-level-review-expiry.sh scripts/ref-archive-reminder-pre-commit.sh .git/hooks/pre-commit`
- `bash scripts/file-level-review-expiry.sh`
- `bash scripts/ref-archive-reminder-pre-commit.sh`
- `pnpm typecheck`
- `pnpm test` — 190 files and 2110 tests passed.
- `pnpm build`

## Final Status / Handoff

Completed. Future final records follow the root and bucket indexes; non-final LLM-facing work remains in the ignored `.ref/` workspace.

Completed At: 2026-07-09
