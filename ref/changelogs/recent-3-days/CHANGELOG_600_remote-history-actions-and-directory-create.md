---
changelog_id: 600
changed_at: 2026-08-12
---

# CHANGELOG_600_remote-history-actions-and-directory-create: Complete Remote list interactions

## Summary

Local and Remote Live/History session cards now use the same pointer-anchored context-menu
interaction. Supported Remote Cores also expose authoritative archive, unarchive, delete, and
Workspace directory-create operations instead of presenting read-only approximations.

## Changes

### Session-list parity

- Share one card frame, metadata hierarchy, pin presentation, and mouse-position context menu
  between Local and Remote Live/History rows.
- Keep actions on right-click for both lists, clamp the menu within the viewport, and close it on
  outside interaction, scrolling, resize, blur, or Escape.
- Add Remote History archive, unarchive, and delete actions with capability gating, confirmation,
  fixed user-facing errors, and immediate list refresh.

### Remote mutation authority

- Add negotiated history-write methods with exact Renderer-to-Main Core/generation authority,
  connected-only admission, row revision/archived-state checks, and generation-scoped idempotency.
- Preserve session/team lifecycle behavior when archiving, restoring, or deleting a Remote session,
  while failing stale rows closed with a refresh-required conflict.
- Return only bounded session identity, state, and revision fields across the Remote contract.

### Workspace directory creation

- Add a capability-gated “新建文件夹” flow to the Remote Workspace picker and remove redundant
  explanatory copy from the compact dialog.
- Create exactly one validated direct child below the selected Workspace-relative directory, with
  canonical containment checks and no absolute server path crossing the protocol.

## Validation

- The complete Electron suite passed 958 files / 6,116 tests; 2 files / 3 explicit live or
  environment cases were skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build, deployment/static
  checks, diff hygiene, and the production file-size gate passed.

## Do Not Split Protection

No exception is required. Contracts, Core mutations, Main routing, and shared Renderer menus are
split into focused modules, and every changed production TypeScript file remains below 500 lines.
