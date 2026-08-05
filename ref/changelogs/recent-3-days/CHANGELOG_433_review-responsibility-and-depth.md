---
changelog_id: 433
changed_at: 2026-08-04
---

# CHANGELOG_433_review-responsibility-and-depth: Unify review roles and depth

## Summary

The bundled review prompts now separate orchestration from artifact judgment with one concise,
consistent structure. Review skills coordinate and adjudicate; reviewer agents inspect artifacts
and produce evidence. Review depth is severity-driven: CRITICAL/HIGH and material MEDIUM evidence
may extend work, while LOW/INFO may be fixed opportunistically but never open or extend a round.

## Unified skill contract

- Rewrite all six `simple-review` and `deep-review` copies into the same
  `Role -> Setup -> Evidence -> Lifecycle -> Failure -> Report` structure; the three adapter copies
  of each skill remain byte-identical.
- Keep `simple-review` to one independent paired pass, at most one material-finding rebuttal, and
  user judgment. It grants no write authority and cannot become a fix-and-re-review loop.
- Keep `deep-review` to severity-eligible initial, evidence-follow-up, post-fix, and residual passes,
  with authorized remediation, a major-decision boundary, and a final convergence gate.
- Preserve exactly two user-confirmed heterogeneous reviewers, complete paired batch coverage,
  integration batches, bounded `spawnLimits`, cache isolation, turn boundaries, message anchors,
  same-worker retry, and failure recovery.

## Unified reviewer contract

- Rewrite Claude, Codex, and Grok reviewers into the same
  `Role -> Input -> Review Standard -> Validation -> Output -> Delivery` structure while retaining
  adapter-specific tools, models, effort, runtime defaults, commands, temporary paths, and delivery
  calls.
- Admit findings only when a supported normal environment, ordinary operation, or evidence-backed
  nearby design evolution can reproduce a visible defect or concrete current cost. Continue to
  allow adversarial input at real trust boundaries.
- Review plans for cohesive ownership, loose directional coupling, overdesign, and evidence-backed
  future extensibility. Review code for over-defensive behavior, dead or no-effect code, and
  unjustified compatibility or fallback paths.
- Require MEDIUM impact and normal-scenario likelihood so the lead can judge materiality. LOW/INFO
  remain concrete, quota-free, and unable to trigger rebuttal, adjacent investigation, or another
  round; obvious authorized fixes still receive focused lead-side validation.

## Contract tests and size

- Replace repeated exact-prose assertions with 11 checks covering metadata, ordered section
  structure, byte-identical skill copies, role ownership, pairing/batching, severity depth,
  normal-path admission, plan/code lenses, validation safety, delivery anchors, and adapter-specific
  runtime wording.
- Across the six skills and three reviewer agents, prompt bytes decreased from 152,594 to 84,102
  (about 45%) without introducing a shared reference or removing safety and recovery contracts.
- The reviewer runtime contract test decreased from 311 to 233 lines.

## Validation

- All six skills passed `quick_validate.py`; Homebrew Python was used because the local `mise`
  configuration did not provide a Python executable.
- Targeted reviewer runtime tests passed 11 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed 470 files and 3,869 tests; one opt-in live smoke test remained skipped.
- `pnpm build` passed.
- Prompt inventory hashes, the pre-rewrite backup manifest, and `git diff --check` passed.

## Do Not Split Protection

No changed source or prompt asset exceeds 500 lines. The longest changed prompt is 92 lines, and
the changed contract test is 233 lines. Each prompt remains independently executable.

## Notes

The active prompt-asset custom point remains satisfied: runtime resources contain no migrated
asset names or repository maintenance-format guidance. Original pre-change assets and the later
pre-rewrite state are both retained in ignored, hash-verified local backup snapshots.
