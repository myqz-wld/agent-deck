---
review_id: 294
reviewed_at: 2026-09-29
baseline_commit: ae0f3ad32525b06d91e8385084d3cb8290a5208f
expired: false
---

# Claude permission indicators

## Scope

```review-scope
src/renderer/lib/sandbox-options.ts
src/renderer/lib/__tests__/sandbox-options.test.ts
src/renderer/components/pending-rows/ExitPlanRow.tsx
```

## Findings and fixes landed

LOW: Claude's no-prompt permission option showed an extra warning icon compared with other
adapters' approval options. Removed that option's warning marker in shared permission selectors
and the native plan-exit selector. The user's final instruction preserves all existing wording,
including parenthetical labels and hover descriptions. Permission values and behavior are unchanged.

## Validation

Typecheck and 32 relevant existing tests passed. Updated the existing indicator expectation;
no additional copy-mirroring tests were added. Changed files remain below 500 lines.

## Residual risk and follow-ups

No remaining source concern for this presentation change. Packaged Desktop activation is deferred
under the user's existing instruction; the hosting application was not rebuilt or restarted.
