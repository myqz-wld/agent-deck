# REVIEW_124 — pending AskUserQuestion and Plan action placement

- Trigger: user report that AskUserQuestion and Plan rows show duplicate buttons in the lower-right area, and Plan feedback should appear below the action buttons instead of at the bottom of the row.
- Scope: renderer pending rows for AskUserQuestion and ExitPlanMode / MCP plan review.
- Method: source trace and typecheck. No reviewer pair was spawned because this is a narrow renderer layout cleanup with no protocol or persistence change.
- Related changelog: [CHANGELOG_287.md](../changelogs/CHANGELOG_287.md).

## Findings

1. **LOW fixed: AskUserQuestion had duplicate submit controls**
   - Evidence: `AskRow` rendered one submit button in the row header and another submit button in a bottom-right action strip.
   - Fix: removed the bottom action strip; the header submit button is the single response action.

2. **LOW fixed: Plan feedback controls appeared below the plan body**
   - Evidence: `ExitPlanRow` opened the feedback textarea and send/cancel buttons after `PlanMarkdownPanel`, so the input landed at the bottom of long plan rows.
   - Fix: moved the textarea under the top-right button group and removed the bottom send/cancel buttons. The same continue-planning button submits the optional feedback once the input is open.

## Validation

- `pnpm typecheck` passed.

## Residual Risk

- No screenshot automation was added for these small row-layout changes; visual validation should happen in the running app with a pending AskUserQuestion and plan review row.
