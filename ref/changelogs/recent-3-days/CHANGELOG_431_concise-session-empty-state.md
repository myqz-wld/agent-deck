---
changelog_id: 431
changed_at: 2026-08-03
---

# CHANGELOG_431_concise-session-empty-state: Simplify the session empty state

## Summary

The session-list empty state now focuses on how to create a Claude Code, Codex CLI, or Grok Build
session without separately advertising Claude Gateway selection.

## Renderer

- Removed the Claude Gateway availability clause from the primary empty-state creation hint.
- Kept the existing expandable terminal-session guidance unchanged.
- Added a focused renderer test that protects the concise wording.

## Validation

- Focused `SessionList` renderer test.
- `pnpm typecheck`.
- `git diff --check`.

## Do Not Split Protection

Not applicable; this is an atomic copy and test update.
