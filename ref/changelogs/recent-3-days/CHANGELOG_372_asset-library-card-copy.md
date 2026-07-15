---
changelog_id: 372
changed_at: 2026-07-15
---

# CHANGELOG_372_asset-library-card-copy: Align asset-library controls and metadata

## Summary

The Asset Library now gives Skills, Agents, and app conventions the same injection-control template,
shows configured thinking effort on Agent cards, and no longer renders slash-command hints as a
separate small-label row.

## Changes

### Injection controls

- Replaced the three tab-specific toggle labels and help blocks with one shared template.
- Kept each tab's existing Claude and Codex setting keys and runtime behavior unchanged.
- Clarified consistently that the switches control bundled Agent Deck assets, leave user and project
  assets untouched, and affect only newly created sessions.

### Agent metadata and asset cards

- Normalized Claude Agent `effort` and Codex Agent `model_reasoning_effort` into one display-only
  `thinking` field for bundled and user asset scans.
- Added “思考程度” beside model and tool metadata on Agent cards.
- Removed the description-derived slash-command hint metadata and its separate chip row. Skill
  descriptions and trigger behavior remain unchanged.

### Regression coverage

- Added component tests for the shared injection template, setting-key routing, Agent metadata, and
  the removed command-hint row.
- Extended the dual-root bundled-asset test to cover Claude and Codex thinking metadata.

## Validation

- `pnpm typecheck` passed.
- Focused asset suite: 3 files / 9 tests passed.
- Full suite: 312 files / 2,849 tests passed; one credentialed live smoke remained skipped.
- `pnpm build` passed.
- `git diff --check` passed before the final record update.
- In-app browser visual QA could not start because the browser runtime rejected initialization with
  a process-property conflict; component-level DOM tests cover the requested display behavior.

## Do Not Split Protection

None. Every changed production TypeScript / TSX file remains below 500 lines.

## Notes

README documentation was intentionally left unchanged at the user's direction because these are
asset-panel presentation details, not durable usage guidance.
