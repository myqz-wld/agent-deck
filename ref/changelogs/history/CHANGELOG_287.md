# CHANGELOG_287: clean up pending question and plan actions

## Summary

AskUserQuestion and plan review rows now keep their action controls in the top-right area only. Duplicate bottom-right action buttons were removed, and plan feedback is entered directly below the top-right plan buttons.

## Changes

- Removed the duplicate bottom submit area from `AskRow`; the top-right submit button remains the only submit action.
- Moved ExitPlanMode / MCP plan-review feedback input under the top-right button group.
- Removed the bottom plan feedback action strip; the existing continue-planning button becomes the feedback submit action once the input is open.

## Validation

- `pnpm typecheck`
