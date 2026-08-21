---
changelog_id: 596
changed_at: 2026-08-12
---

# CHANGELOG_596_remote-source-flat-styling: Simplify Remote source styling

## Summary

The Remote source manager now uses restrained, flat dark surfaces without blue gradients or
luminous selection effects. Selection and connection state remain legible through neutral borders,
text labels, and semantic status colors.

## Changes

- Remove blue gradients from the manager header, connection cards, empty state, and credential
  chooser, and replace them with low-contrast solid surfaces.
- Replace the selected connection's glowing blue edge and shadow with a plain neutral border,
  subtle fill, and neutral `默认连接` badge.
- Remove glow shadows from status dots while preserving their green, amber, red, and offline colors
  and accompanying text labels.
- Restyle add, save, input focus, and unconfigured-credential states with neutral controls so the
  dialog uses color primarily for connection health and destructive actions.
- Add regression coverage that rejects gradient styling in both the manager and profile form.

## Validation

- Focused Remote manager and dialog coverage passed 2 files / 23 tests.
- `pnpm typecheck` passed the architecture boundaries and both TypeScript projects.
- `pnpm build` and `git diff --check` passed.
- A local browser fixture verified the dialog's visible control structure; the browser screenshot
  channel did not return usable pixels and is not counted as visual acceptance evidence.

## Do Not Split Protection

No exception is required. Every changed production source file remains below 500 lines; the
largest touched production file is `RemoteProfileForm.tsx` at 187 lines.

## Notes

- This is renderer-only styling. It changes no Remote source selection, connection lifecycle,
  persistence, preload contract, or IPC behavior.
