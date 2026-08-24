---
review_id: 258
reviewed_at: 2026-08-20
baseline_commit: 07fff3185b1ff1949f0a893ddd67ce9963b83cd1
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final follow-up records and bucket indexes are mechanical evidence added after implementation."
---

# REVIEW_258_session-create-button-stability: Remove the remaining creation-action jump

## Scope and method

This follow-up review traced the create action's label, disabled attribute, opacity, and intrinsic
width across settled, fast configuration revalidation, slow revalidation, and active creation. It
also checked the three Local form call sites and the shared Remote creation flow. The repository
review-expiry report was run before the review.

```review-scope
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/new-session/NewSessionForm.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Configuration revalidation changed the create button to `正在准备…` and disabled opacity immediately, even though the model projection intentionally retained its prior display for 150 ms. A fast read therefore still produced a visible button jump. | Keep the settled label and visual enabled/disabled state through the same grace window. Submission remains functionally blocked, and the delayed disabled presentation begins only with the target loading/progress projection. |
| LOW | Idle, preparing, and creating labels had different intrinsic widths, so ordinary state changes could move the cancel/create action group. | Remove the extra preparing label and overlay invisible idle/creating width reservations with the visible state in one intrinsic grid. The button box no longer resizes between idle and creating states. |

## Validation and evidence

- Timing coverage proves the same create-button node and label remain present through a fast Codex
  switch, through 149 ms of a slow switch, and after the target model settles.
- Slow-read coverage proves the button becomes visually disabled only when configuration progress
  appears at 150 ms, while its native disabled boundary prevents submission throughout the read.
- Focused Local/Remote new-session, issue-resolution, and handoff coverage passed 6 files / 53
  tests.
- `pnpm typecheck` passed architecture, Core Node, and TypeScript checks.
- `pnpm test` passed 994 files and 6,241 tests; 2 files and 3 opt-in tests were skipped.
- `pnpm build` passed main, preload, renderer, and build-info generation.
- `git diff --check` and the 500-line production-source guard passed.

## Residual risk

- The button is intentionally functionally disabled during the invisible fast-read grace even when
  its last settled enabled appearance is retained. A read that crosses 150 ms exposes the disabled
  state and progress text; fast reads complete before that visual distinction is needed.
- Installed-app acceptance remains pending packaging and restart.

## Verdict

PASS. The model projection and creation action now share one visible 150 ms transition boundary,
and the action row retains stable geometry across create states.
