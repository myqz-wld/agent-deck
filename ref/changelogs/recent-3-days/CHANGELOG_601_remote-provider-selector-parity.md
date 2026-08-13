---
changelog_id: 601
changed_at: 2026-08-12
---

# CHANGELOG_601_remote-provider-selector-parity: Align Remote provider selectors

## Summary

Remote Claude Gateway and Codex Provider controls now share the same searchable combobox
presentation as Local. Codex and Claude also retain a usable empty native-configuration state when
the Worker discovers no custom provider definitions.

## Changes

### Provider capability truthfulness

- Keep the native Claude `settings.json` and Codex `config.toml` provider choices enabled even when
  the automatically derived catalog contains no custom provider identifiers.
- Accept bounded custom Gateway and Provider identifiers in both Local and Remote while keeping
  automatically discovered identifiers as suggestions and retaining the empty Worker-native value.

### Local and Remote UI parity

- Use the shared searchable Provider combobox for both Local and Remote session-model fields.
- Let Local and Remote users either select an automatically discovered Gateway or Provider or type
  one directly in the same control.
- Represent the native configuration exactly as Local does: an empty input with the existing
  placeholder, without adding a synthetic native option to the dropdown.
- Treat an empty custom Provider catalog as a normal native-configuration state and avoid
  presenting it as a `config.toml` configuration error.
- Use the same neutral empty-catalog copy in Local and Remote instead of attaching source-specific
  remediation to an expected state.

## Validation

- Focused session-capability and Local/Remote dialog coverage passed 4 files / 42 tests.
- The complete Electron suite passed 958 files / 6,121 tests; 2 files / 3 explicit live or
  environment cases were skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build, and diff hygiene
  passed.

## Do Not Split Protection

No exception is required. Capability projection and the shared Renderer control remain in focused
modules, and every changed production TypeScript file remains below 500 lines.
