# CHANGELOG_295 - Diff enlarge overlay portal

## Summary

- The enlarged diff view now renders through a `createPortal(document.body)` overlay with `z-[60]`, matching the portal approach used for top-level modals that must escape `FloatingFrame` and backdrop-filter containing blocks.
- This prevents the enlarged diff file path/header from overlapping with the underlying app top navigation.

## Validation

- `pnpm typecheck`
- `pnpm build`
