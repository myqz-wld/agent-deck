---
changelog_id: 670
changed_at: 2026-10-01
---

# Show Feishu settings only for remote hosts

## Summary

Local settings no longer show the Feishu robot group or its remote-host guidance.
Remote settings retain the existing model preferences and connection status messages.

## Changes

- Render the Feishu settings group only when the dialog has a remote source.
- Render no preference content when the section receives a null source.
- Update the existing settings hierarchy test to distinguish the remote-only group,
  and document its scope in the README.

## Validation

- `pnpm typecheck` passed, including architecture boundaries and both TypeScript projects.
- `pnpm test src/renderer/components/SettingsDialog.test.tsx src/renderer/components/SettingsDialog.remote.test.tsx src/renderer/components/settings/FeishuPreferencesSection.test.tsx`
  passed: 3 files, 25 tests.
- `git diff --check` passed.

## Do Not Split Protection

None. Changed source and test files remain below 500 lines.

## Notes

Renderer-only change; development uses HMR without a process restart.
