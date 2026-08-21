---
changelog_id: 593
changed_at: 2026-08-12
---

# CHANGELOG_593_new-session-defaults-and-tab-alignment: Stabilize session defaults and UI alignment

## Summary

New-session dialogs now wait for the authoritative adapter configuration before presenting model
values, eliminating the brief fallback-to-configured-model jump. Related settings and session
detail surfaces now use the established dark visual treatment and consistent compact alignment.

## Changes

### New-session default resolution

- Track default-resolution readiness by adapter, working directory, and provider-selection
  revision so stale configuration reads remain fenced and each visible model summary belongs to
  the current request.
- Present one neutral loading placeholder while model defaults are unresolved instead of briefly
  exposing a fallback model. Keep directory and first-message authoring available, while gating
  configuration-dependent controls and session creation until the resolved values are ready.
- Apply the same readiness contract to standard Local and Remote creation plus Local and Remote
  issue-resolution entry points.

### Dark-theme and alignment polish

- Replace the green creation-target notice and red settings reset surface with neutral black/gray
  styling. The reset confirmation remains destructive so its safety semantics do not change.
- Keep all four settings category tabs on one compact line with shrink-safe equal widths.
- Give the Diff tab's loading, failure, and no-change states the same horizontal and vertical
  inset used by the other session-detail empty states.

## Validation

- `pnpm typecheck` passed the architecture boundaries and both Node and Web TypeScript checks.
- Focused renderer regression coverage passed 38 tests across new-session initialization,
  issue-resolution creation, settings tabs/reset styling, and Diff empty-state alignment.
- The complete `pnpm test` suite passed 943 files and 6,048 tests; three conditional tests were
  skipped.

## Do Not Split Protection

No exception is required. Every changed production source file remains below 500 lines; the
largest touched file is `SettingsDialog.tsx` at 490 lines.

## Notes

- This is renderer-only work and uses the existing HMR path; no main/preload restart contract,
  persistence schema, or IPC surface changed.
