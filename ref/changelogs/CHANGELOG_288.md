# CHANGELOG_288: keep plan feedback controls stable

## Summary

Pending plan rows now keep the original top-right button layout when feedback is opened. The optional feedback field appears as a separate single-line input row below the row header.

## Changes

- Moved `ExitPlanRow` feedback entry out of the top-right action group.
- Replaced the two-line feedback textarea with a single-line input below the header.
- Kept the continue-planning button label stable; pressing Enter in the input or clicking the same button submits the optional feedback.

## Validation

- `pnpm typecheck`
