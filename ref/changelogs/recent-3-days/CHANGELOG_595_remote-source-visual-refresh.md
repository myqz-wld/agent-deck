---
changelog_id: 595
changed_at: 2026-08-12
---

# CHANGELOG_595_remote-source-visual-refresh: Refresh Remote source styling

## Summary

The Remote source manager now follows Agent Deck's dark glass theme instead of presenting every
connection on an opaque gray tile. Selection, connection health, and available actions remain
distinct without changing any source or connection behavior.

## Changes

- Replace the gray connection-card fills with transparent dark surfaces and a restrained blue
  gradient, edge highlight, and `默认连接` badge for the selected Remote profile.
- Give connected, connecting/reconnecting, incompatible, and offline states their own compact
  status pills while keeping text labels available independently of color.
- Convert connect, disconnect, edit, and delete controls into a lighter icon toolbar separated from
  the selectable connection summary.
- Add a connected/total summary to the dialog header and align its add action, empty state, profile
  input, credential picker, and save action with the same blue-accented glass treatment.

## Validation

- Focused Remote manager and dialog coverage passed 2 files / 23 tests.
- `pnpm typecheck` passed the architecture boundaries and both Node and Web TypeScript checks.
- The complete `pnpm test` suite passed 944 files / 6,053 tests, with 2 files / 3 conditional skips.
- `pnpm build` and `git diff --check` passed.

## Do Not Split Protection

No exception is required. Every changed production source file remains below 500 lines; the
largest touched production file is `RemoteProfileForm.tsx` at 187 lines.

## Notes

- This is renderer-only work. It changes no Remote source selection, connection lifecycle,
  credential storage, persistence schema, preload contract, or IPC surface.
