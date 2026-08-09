---
changelog_id: 505
changed_at: 2026-08-05
---

# CHANGELOG_505_claude-gateway-profiles-core-boundary: Port Gateway profile policy

## Summary

Claude Gateway profile discovery and settings projection now run in a host-neutral Core. The
desktop host retains home-directory, path, and filesystem access while all callers keep the stable
`gateway-profiles.ts` API.

## Host-neutral Gateway profile Core

- Added `gateway-profiles-core.ts` with the exact profile-id grammar, settings-path admission,
  directory-entry filtering, symlink-to-file acceptance, alphabetical ordering, and fail-open
  directory/stat behavior.
- Preserved trimmed gateway selection, missing-profile errors, JSON-object validation, and bounded
  public projection of string-only environment metadata.
- Preserved model resolution semantics: explicit Fable/Opus/Sonnet/Haiku aliases win and otherwise
  fall back to `ANTHROPIC_MODEL`; credential and other environment values never enter the result.

## Thin desktop host and stable facade

- Added `gateway-profiles-host.ts` as the sole owner of `homedir`, path joins, directory reads,
  filesystem type/existence probes, and settings-file reads.
- Reduced `gateway-profiles.ts` to a compatibility facade that injects the desktop host and retains
  every existing function, constant, type, default argument, and caller import path.
- Added direct Core tests for traversal rejection, deterministic discovery, failure handling,
  settings projection, alias fallback, missing profiles, and invalid JSON objects, plus a direct
  desktop-host filesystem test.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, concrete stores/runtime
  utilities, Node built-ins, Electron, and electron-log from Gateway profile Core.
- Added Claude Gateway profile Core as the seventieth executable Node 22 boundary candidate.

## Validation

- Focused Core/host/facade/fork/defaults coverage: passed, 7 files / 17 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 705 files / 4,951 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep Gateway profile Core, desktop host, stable facade, direct-import rule, and projection tests
together. Profile discovery must stay fail open, resolution must stay fail closed for missing or
invalid selected files, and credential-bearing environment values must never cross the projection.

## Remaining boundary

Claude Gateway profile policy is now host neutral. The wider provider output stream plus concrete
provider composition/repository ownership remain, alongside real Linux/SSH/Feishu/provider
acceptance.
