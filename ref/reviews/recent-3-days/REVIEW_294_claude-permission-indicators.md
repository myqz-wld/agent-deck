---
review_id: 294
reviewed_at: 2026-09-29
baseline_commit: 0be35722bd1e45f125629c512f4651643f1537f3
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
and the native plan-exit selector. Removed only the parenthetical annotations from the shared
plan and no-prompt labels, preserving their base wording and hover descriptions. Permission values
and behavior are unchanged.

## Validation

Typecheck and 32 relevant existing tests passed. Updated the existing indicator expectation;
no additional copy-mirroring tests were added. Changed files remain below 500 lines.

## Residual risk and follow-ups

No remaining source concern for this presentation change. The user subsequently authorized Desktop
replacement, completed with clean `6d4d44ad` on 2026-09-29. Inspection of the installed renderer
bundle confirms the base labels, absent parenthetical annotations and absent no-prompt warning
marker. Source tests establish the shared/native selector behavior; no additional live selector
screenshot is claimed. See [installed acceptance](../../plans/recent-3-days/PLAN_64_feishu-desktop-activation.md).
