---
changelog_id: 373
changed_at: 2026-07-15
---

# CHANGELOG_373_review-skill-lifecycle: Separate simple and deep review lifecycles

## Summary

The bundled Claude and Codex review skills now share one cache, reviewer, evidence, and failure-handling protocol while keeping their execution models explicit. `simple-review` performs one independent review round and one rebuttal round before returning the decision to the user. `deep-review` continues iterative in-scope rounds and asks for intermediate user review only when remediation requires an architecture-level or similarly major decision.

## Shared review protocol

- Replaced `.deep-review-cache/` with the provider-neutral `.review-cache/` in all four bundled skill counterparts and the repository `.gitignore`.
- Removed the invocation-shaped TypeScript scope object and `ack_cache_unignored` escape hatch. Skills now derive natural-language scope from the user request and normalize paths for reviewer prompts.
- Require `.review-cache/` in the review root's `.gitignore` before staging external paths. A missing entry is added; an unwritable ignore file blocks cache creation.
- Aligned reviewer selection, cache lifecycle, turn boundaries, evidence adjudication, severity, finding requirements, and failure recovery wording across both skills.

## Distinct lifecycles

- `simple-review` now stops after one review and one cross-reviewer rebuttal round. It performs no automatic fix or second review round and ends with `USER_DECISION_REQUIRED` plus concrete user choices.
- `deep-review` keeps the same heterogeneous reviewer pair across iterative rounds, supports read-only and authorized review-and-fix scopes, and autonomously handles localized remediation.
- Deep review pauses only for material architecture, public-contract, persistence, security, destructive-behavior, compatibility, or major scope/risk decisions.
- Updated the root README summary and added focused regression assertions for the shared cache contract, removed acknowledgement parameter, paired Claude/Codex equality, and lifecycle distinction.

## Reviewer agent contract

- Updated the actual `reviewer-claude`, `reviewer-codex`, and `reviewer-deepseek` assets to accept batched rebuttals and return one evidence-backed verdict per stable finding id.
- Added explicit `COMPLETE` / `INCOMPLETE` coverage, reviewed and unreadable path reporting, strict round-focus behavior, and a narrowly labeled exception for verified out-of-focus CRITICAL/HIGH blockers.
- Added concrete trigger/consequence examples for complex findings and a routine/major decision-impact signal for the lead's deep-review user boundary.
- Defined commit and working-tree baselines, including staged and unstaged diffs, so later rounds no longer assume a commit hash.
- Hardened read-only validation with isolated per-invocation temporary directories, cleanup, worktree status checks, mutating-command restrictions, and a network privacy boundary.
- Expanded the bundled runtime contract test to load all three real reviewer bodies while preserving their intentional model, adapter, effort, and tool differences.

## Validation

- Focused reviewer-runtime contract: 1 file, 8 tests passed, including all three actual reviewer assets and direct frontmatter/TOML parsing.
- `pnpm typecheck` passed.
- `pnpm test` passed 312 files and 2,855 tests; one opt-in live smoke file/test remained skipped.
- Claude/Codex `simple-review` files are byte-identical; Claude/Codex `deep-review` files are byte-identical.
- `git diff --check` passed, and active bundled skill assets contain no `.deep-review-cache` or `ack_cache_unignored` reference.
- Prompt-asset inventory hashes were refreshed, and every pre-edit backup still matches its manifest hash.
- Per the user's direction, no reviewer or review-skill workflow was started for this change.

## Do Not Split Protection

No changed first-party source file exceeds 500 lines. Each skill remains below 200 lines and keeps its complete executable protocol self-contained.
