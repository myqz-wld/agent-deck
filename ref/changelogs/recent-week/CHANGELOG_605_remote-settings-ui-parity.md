---
changelog_id: 605
changed_at: 2026-08-13
---

# CHANGELOG_605_remote-settings-ui-parity: Align Remote Settings presentation

## Summary

Remote Settings now uses the same groups and section order as Local while keeping remote-owned
values visibly disabled. Remote Settings and Assets also use concise user-facing language instead
of repeating deployment ownership details or exposing internal location names.

## Changes

### Settings parity

- Render the same four general-setting groups and section order for Local and Remote: session,
  appearance, runtime integration, and MCP.
- Place desktop notifications, window behavior, keyboard shortcuts, and logs in the same positions
  for both sources while keeping them backed by this computer's settings.
- Present available remote runtime defaults in the matching sections with disabled controls, and
  keep unsupported remote values represented without falling back to Local runtime data.
- Add stable group and section markers plus an exact hierarchy regression test to prevent future
  Local/Remote presentation drift.

### User-facing copy

- Replace repeated Worker ownership and read-only explanations with one concise notice per dialog.
- Remove internal Provider Home and Remote Core terms from the affected Settings and Assets views,
  including loading, unavailable, empty, and error states.
- Hide remote filesystem paths and repeated read-only badges from asset cards and content viewers
  while retaining disabled injection and application-convention controls.

## Validation

- Two parallel read-only audits independently passed the structure/copy and visual-style acceptance
  checks, including grouping, spacing, disabled states, single-notice behavior, and terminology.
- Focused Settings and Assets tests passed. The complete Electron suite passed 960 files / 6,146
  tests, with 2 files / 3 explicit environment cases skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build, and diff hygiene
  passed.
- The current-source Local and Remote dialogs were compared in the browser; their group and section
  ordering matched and the console reported no errors or warnings.

## Do Not Split Protection

No exception is required. The remote projection remains isolated in a focused section component,
and every touched production TypeScript file remains below the repository's 500-line limit.
