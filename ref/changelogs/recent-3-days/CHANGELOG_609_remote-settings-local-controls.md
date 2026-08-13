---
changelog_id: 609
changed_at: 2026-08-13
---

# CHANGELOG_609_remote-settings-local-controls: Clarify Remote settings ownership

## Summary

Remote Settings now keeps settings owned by the current computer editable and gives generator
fields enough room to show their normal labels and default-value text.

## Changes

### Current-computer settings

- Keep reminder, window, and log controls editable while viewing a Remote source.
- Continue to show server-owned lifecycle, generator, integration, and MCP settings as read-only.
- Replace the ambiguous ownership notice with a direct explanation of which settings can still be
  changed and why the keyboard section is informational.

### Generator layout

- Widen the Settings dialog from 26 rem to 28 rem where the window has room.
- Allocate two grid columns to the longer provider and model fields, while adapter and thinking
  retain one column each.
- Preserve a one-column fallback below 420 px and remove intrinsic minimum width from the provider
  combobox so it cannot force content outside its grid cell.

## Validation

- `pnpm typecheck` passed, including both architecture boundary checks.
- The complete Electron test suite passed: 960 files and 6,141 tests, with only opt-in smoke tests
  skipped.
- Three focused Settings suites passed with 19 tests.
- `pnpm build` and `git diff --check` passed.
- The production stylesheet contains the 28 rem dialog width and the responsive three-column grid
  with one-column and two-column field spans.

## Do Not Split Protection

No exception is required. Every changed production TypeScript file remains below 500 lines.

## Related review

- `ref/reviews/recent-3-days/REVIEW_243_remote-settings-local-controls.md`
