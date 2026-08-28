---
changelog_id: 409
changed_at: 2026-07-27
---

# CHANGELOG_409_session-runtime-defaults-ui: Align session defaults and runtime inheritance

## Summary

Codex CLI sessions now default to `approvalPolicy: never` when no explicit or inherited value
applies. Spawn and hand-off preserve the complete persisted runtime only for same-adapter targets;
cross-adapter targets use their own defaults.

Grok Build selectors now list only `read-only`, `workspace`, `off`, and custom profiles across
settings, creation, hand-off, Issue resolution, and live-session controls. The creation UI also
removes the extra explanatory paragraph below the Codex approval picker.

## Changes

### Codex approvals and session inheritance

- Default ordinary Codex creation to `never` at the adapter options boundary while preserving
  explicit human selections and same-adapter inherited policies.
- Fall back to `never` when effective Codex configuration contains no valid approval policy.
- Extend same-adapter Codex spawn inheritance to approval policy, network access, and additional
  directories, matching the existing sandbox/model/thinking inheritance.
- Keep hand-off precedence as explicit value, complete same-adapter persisted runtime, then target
  defaults. Cross-adapter targets never copy source permission, sandbox, or runtime-access fields.
- Preserve reviewer-specific network/read roots while sharing the ordinary Codex `never` approval
  default.

### Renderer

- Remove `strict` and `devbox` from every Grok built-in selector while retaining backend, CLI,
  MCP, and custom-text support for all native profiles.
- Present existing `strict` or `devbox` session values through the custom-profile field instead of
  silently remapping or mislabelling them.
- Remove the standalone approval-policy description from both human Codex creation dialogs while
  retaining per-option tooltips.

### Documentation and prompt assets

- Document complete same-adapter versus cross-adapter runtime precedence in README and MCP tool
  descriptions.
- Align Codex, Claude, and Grok injected runtime instructions with the `never` default and
  inheritance boundary.
- Keep the three reviewer agent counterparts unchanged; their runtime-specific guidance remains
  accurate.

## Validation

- `pnpm typecheck` passed.
- Focused runtime, MCP, renderer, prompt-resource, and hand-off suites passed.
- Full `pnpm test` completed with 398 files and 3,362 tests passing, with one credentialed smoke
  test skipped. The command exited nonzero because three environment-bound suites (8 tests) could
  not listen on Unix sockets or `127.0.0.1` under the active filesystem/network sandbox; isolated
  retries confirmed the same `EPERM` boundary.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Prompt inventory, backup manifest, original hashes, refreshed hashes, paired assets, and local
  resource paths were verified.

## Do Not Split Protection

All changed production TypeScript and TSX files are at or below 500 lines.

## Notes

- Grok `strict` and `devbox` remain valid native profiles. This change removes them only from the
  renderer's built-in choice list.
- Pre-edit prompt assets can be restored from
  `.prompt-asset-improver/local/backups/20260728T064356Z/`.
