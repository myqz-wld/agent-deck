# CHANGELOG_321: Collapsed taller present_diff cards

Changed MCP `present_diff` cards so diff content starts collapsed and opens into a taller review area.

## Changes

- Made `present_diff` cards default to a collapsed content panel with an expand/collapse button matching the plan row interaction.
- Deferred rendering the Monaco diff view until the user expands the panel.
- Increased PR-style `present_diff` cards from a fixed 320px panel to a responsive 60vh panel with a 384px minimum and 704px maximum.
- Increased merge-conflict and raw-payload pane scroll limits so long presented fragments are easier to inspect.
- Updated the README capability summary to note the collapsed-by-default, taller scrollable diff presentation area.

## Validation

- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
