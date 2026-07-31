---
changelog_id: 408
changed_at: 2026-07-27
---

# CHANGELOG_408_concrete-session-creation-defaults: Simplify new-session runtime choices

## Summary

New-session dialogs now resolve and show concrete model, thinking, permission, and sandbox values
instead of presenting “follow default” choices. Model configuration stays compact behind a closed
disclosure, while the existing per-adapter last-selection memory continues to override resolved
configuration during the current app run.

The Grok global sandbox setting now defaults to workspace write access and offers only broad
read-only, workspace-write, fully open, or a custom profile. Existing native-follow, strict, and
devbox settings migrate to the closest retained choice.

## Changes

### Native configuration resolution

- Add a validated IPC read path for concrete session-creation defaults.
- Resolve Claude model and effort from layered user/project `settings.json` files and selected
  Gateway profiles.
- Resolve Codex provider, model, reasoning effort, and approval policy through app-server
  `config/read`, with top-level `config.toml` readers as a fallback.
- Resolve Grok model and reasoning values from top-level config when present, with concrete native
  fallbacks.
- Keep a cleared free-text model out of the create request so the adapter configuration remains
  authoritative.

### New-session UI

- Collapse Gateway/Provider, model, and thinking into one closed-by-default model disclosure.
- Remove unset choices from new-session thinking and all three sandbox selectors.
- Reuse one state hook across ordinary and Issue-resolution creation, preserving per-adapter
  last-used values.
- Order permission, approval, sandbox, and Grok work-mode choices from restrictive to permissive.
- Rename Grok's executable work mode from “默认（可执行）” to “可执行”.

### Grok settings

- Change the global Grok sandbox default to `workspace`.
- Remove `strict` and `devbox` from the settings-page choices while retaining custom profiles.
- Migrate unset and `devbox` values to `workspace`, and `strict` to `read-only`, behind a one-time
  sentinel.

### Documentation

- Explain config-resolved new-session values, same-run memory, and blank-model delegation in the
  README.
- Document the simplified Grok global setting while preserving all native per-session profiles.
- Align the bundled Codex runtime baseline with concrete approval choices for human-created
  sessions and native defaults for MCP-created sessions.

### Tests

- Cover config layering and native default resolution for Claude, Codex, and Grok.
- Cover IPC validation, collapsed model controls, blank-model delegation, concrete sandboxes,
  Grok work-mode copy, strict-to-permissive ordering, and setting migration.

## Validation

- Focused regression suite: 9 files and 91 tests passed.
- `pnpm typecheck` passed.
- Full `pnpm test`: 401 files and 3,367 tests passed; one opt-in smoke test skipped.
- Bundled prompt-asset regression suite: 3 files and 20 tests passed after documentation updates.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.

## Do Not Split Protection

All changed and new production TypeScript/TSX files remain at or below 500 lines.

## Notes

- Live-session and hand-off controls retain their explicit reset/delegation choices because those
  surfaces edit an already established override rather than choosing initial values.
- Custom Grok `sandbox.toml` profile names remain valid even though the global built-in list is
  shorter.
