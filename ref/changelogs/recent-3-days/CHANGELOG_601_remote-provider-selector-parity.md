---
changelog_id: 601
changed_at: 2026-08-12
---

# CHANGELOG_601_remote-provider-selector-parity: Align Remote provider selectors

## Summary

Remote Claude Gateway and Codex Provider controls now share the same searchable combobox
presentation as Local. Codex and Claude also retain an explicit native-configuration choice when
the Worker discovers no custom provider definitions.

## Changes

### Provider capability truthfulness

- Keep the native Claude `settings.json` and Codex `config.toml` provider choices enabled even when
  the automatically derived catalog contains no custom provider identifiers.
- Preserve the Remote trust boundary: custom provider values remain restricted to the exact
  allowlist published by Core, while the empty value continues to mean the Worker-native provider.

### Local and Remote UI parity

- Use the shared searchable Provider combobox for both Local and Remote session-model fields.
- Let Remote users filter advertised Gateway or Provider values without committing arbitrary
  typed text, and commit only a selected Core-owned option.
- Show explicit native-configuration labels for an empty provider selection.

## Validation

- Focused session-capability and Local/Remote dialog coverage passed 4 files / 42 tests.
- The complete Electron suite passed 958 files / 6,121 tests; 2 files / 3 explicit live or
  environment cases were skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build, and diff hygiene
  passed.

## Do Not Split Protection

No exception is required. Capability projection and the shared Renderer control remain in focused
modules, and every changed production TypeScript file remains below 500 lines.
