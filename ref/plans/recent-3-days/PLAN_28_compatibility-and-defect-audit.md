---
plan_id: PLAN_28
title: Compatibility cleanup and functional defect audit
status: completed
created_at: 2026-07-31
updated_at: 2026-07-31
completed_at: 2026-07-31
base_branch: main
base_commit: 6c4819855495e75b6a3fedbcce6be12342d4dd45
related_review: REVIEW_208
related_followup_plan: PLAN_29
related_closure_review: REVIEW_209
---

# PLAN_28_compatibility-and-defect-audit: Two-wave compatibility and defect audit

## Goal and invariants

- Audit compatibility-only logic first, cleaning only proven internal closed loops without user
  confirmation.
- Ask before changing public CLI/MCP, provider, persistence, filesystem, bundled-resource, or
  user-visible boundaries.
- Run a separate fresh wave for functional defects and logic errors.
- Use ordinary independent Codex sessions at `gpt-5.6-sol` and `thinking=max`; never invoke
  `simple-review` or `deep-review`.
- Preserve unrelated work, the Git index, commits, and active Agent Deck sessions.

## Completed execution

### Wave 1 — compatibility

- C1 audited session/store/team/lifecycle internals.
- C2 audited adapters, process/runtime tooling, browser, resources, and scripts.
- C3 audited MCP/IPC/preload/renderer/shared contracts.
- Internal zero-caller and duplicate seams were removed in disjoint write sets.
- The user approved removal of the retired Codex `profile` surface, legacy object-form
  `changeKind` readers, and a zero-production PATH wrapper.
- Old screenshot cleanup, the Grok event alias, current-schema null normalization, and the
  resources-placeholder boundary were retained.

### Wave 2 — defects

- D1 audited state, persistence, ownership, handoff, and MCP lifecycle.
- D2 audited adapter runtimes, processes, external protocols, browser, filesystems, and scripts.
- D3 audited IPC, preload, renderer, shared contracts, and cross-process wiring.
- Lead adjudication confirmed 15 findings: 4 HIGH, 10 MEDIUM, and 1 LOW.
- No defect fix was applied because this wave was review-only.

## Validation

- Focused cleanup tests: 11 files / 199 tests.
- Typecheck passed.
- Full tests: 439 files / 3,579 tests, one explicit live smoke skipped.
- Production build, logger check, and diff check passed.
- Prompt inventory, counterpart parity, backup manifest, and original hashes passed.
- Static finding traces were supplemented by a non-mutating SQLite proof and worker type/syntax
  checks. Native Linux/Windows and live-provider reproductions remain follow-ups.

## Final status and handoff

The requested two-wave audit is complete. Full findings, evidence, compatibility changes, prompt
backup details, and recommended fix order are in
`ref/reviews/recent-3-days/REVIEW_208_compatibility-and-defect-audit.md`.

Open Agent Deck follow-ups:

- State/handoff: `ca2fb20f-39ac-4f9c-b621-5dbd567840ea`
- Runtime/security: `2275955e-7298-4b6e-8c0d-3501e4cafc80`
- IPC/renderer: `bd43815f-6a64-41a2-8e01-e6bc97b04c3d`

## Follow-up closure

All three issues and all fifteen findings were resolved under `PLAN_29`. See `REVIEW_209` for final
integration evidence and `CHANGELOG_427` for the delivered behavior. The issue list above records
the handoff state at the end of this audit plan.
