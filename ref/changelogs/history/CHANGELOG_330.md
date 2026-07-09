# CHANGELOG_330: `present_diff` annotation cards

## Summary

`present_diff` now supports structured annotation cards that keep explanatory prose out of the source panes.

## Changes

- Added optional top-level `annotations` to the MCP `present_diff` payload. Each annotation targets a pane and optional line number so the renderer can insert a small explanation card beside the presented fragment.
- Updated `present_diff` tool and schema descriptions to tell callers to keep before/after/conflict pane content as clean source or diff text, while using `rationale`, `instructions`, and `annotations` for explanations.
- Kept both intro sections visible in the UI: `rationale` renders as a change-reason card and `instructions` renders as a confirmation-points card.
- Preserved the existing Monaco PR diff path when no annotations are provided, and switched annotated PR/conflict fragments to a lightweight pane renderer that can place cards at the requested lines.
- Added validation so annotations using PR panes are rejected in conflict mode, conflict panes are rejected in PR mode, and `base` annotations require a displayed base pane.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts` passed: 9 tests.
- `pnpm exec vitest run src/renderer/components/pending-rows/diff-review-presentation.test.tsx` passed: 4 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.
- Independent read-only Codex review found 0 CRITICAL/HIGH/MEDIUM issues; 2 LOW findings were fixed.

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
