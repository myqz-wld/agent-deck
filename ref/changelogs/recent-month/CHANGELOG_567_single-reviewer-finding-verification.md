---
changelog_id: 567
changed_at: 2026-08-05
---

# CHANGELOG_567_single-reviewer-finding-verification: Verify un-rebutted findings

## Summary

Simple and deep review now require a bounded lead-side verification before a single-worker
MEDIUM, LOW, or INFO finding can receive a final classification or cause an action when the paired
worker did not evaluate it in rebuttal. Silence or absence from the paired worker is not supporting
evidence.

## Review adjudication

- Add the same verification rule to all Claude, Codex, and Grok copies of `simple-review` and
  `deep-review`; each skill remains byte-identical across adapters.
- Keep rebuttal eligibility unchanged: material or recommendation-changing MEDIUM findings may
  still enter rebuttal, while LOW/INFO never open a rebuttal or another review pass.
- Require unverified single-worker findings to remain `UNVERIFIED`, prevent fixes based on them,
  and prevent them from affecting the simple-review recommendation or deep-review final gate.
- Preserve the lead's bounded adjudicator role rather than turning the lead into a third full
  artifact reviewer.

## Validation

- All six skills passed `quick_validate.py` using Homebrew Python 3.14.6 after `mise exec` reported
  that no Python executable was configured.
- The targeted bundled reviewer runtime contract passed 11 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed 471 files and 3,877 tests; one opt-in live smoke test remained skipped.
- Cross-adapter byte equality and `git diff --check` passed.
- Prompt inventory hashes and the pre-edit backup manifest were refreshed and verified.

## Do Not Split Protection

No changed prompt asset exceeds 500 lines. The change adds one adjudication paragraph to each
review skill without introducing another reference or duplicating the rule outside the owning
skills.

## Notes

Reviewer agent assets remain unchanged because they produce findings and rebuttal verdicts but do
not own lead-side classification or final action. The active prompt-asset custom point remains
satisfied: no repository maintenance-format guidance was added to bundled runtime resources.
