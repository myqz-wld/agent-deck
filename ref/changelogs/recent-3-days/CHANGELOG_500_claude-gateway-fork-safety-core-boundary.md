---
changelog_id: 500
changed_at: 2026-08-05
---

# CHANGELOG_500_claude-gateway-fork-safety-core-boundary: Port transcript-root admission

## Summary

Claude Gateway native-fork transcript-root admission now runs in a host-neutral Core. Desktop path
discovery, profile loading, realpath resolution, and process environment remain behind one host while
the existing preflight API and failure copy remain stable.

## Host-neutral Gateway fork safety Core

- Added `gateway-fork-safety-core.ts` with exact main/Gateway root selection, canonical identity
  comparison, native-profile fallback, and fail-closed mismatch guidance.
- Kept the profile ID and both raw roots in the existing operator-facing error so an unsafe native
  fork still directs callers to align roots or choose `contextMode: "fresh"`.
- Made main config-root lookup, Gateway profile resolution, and physical-path canonicalization
  explicit host ports without importing filesystem, path, process, or desktop configuration code.

## Thin desktop host and stable facade

- Added `gateway-fork-safety-host.ts` as the sole owner of config-root discovery, profile loading,
  absolute normalization, `realpathSync`, and NFC canonicalization.
- Reduced `gateway-fork-safety.ts` to a stable Core/Host wrapper, preserving optional Gateway,
  explicit paths, explicit env, and process-env defaults.
- Added direct Core admission/rejection tests and a direct host test proving symlink spellings resolve
  to one physical root; retained the existing full preflight tests.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, fork/profile loaders,
  repositories, Node built-ins, Electron, and electron-log from Gateway fork safety Core.
- Added Claude Gateway fork safety Core as the sixty-fifth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, Gateway preflight, native-fork, and adapter coverage: passed, 5 files / 23 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-five Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 696 files / 4,921 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep Gateway fork safety Core, desktop host, stable facade, profile/config-root resolvers,
direct-import rule, and physical-root tests together. Native fork must compare physical transcript
roots, must not mutate process environment, and must fail closed before SDK fork on any mismatch.

## Remaining boundary

Claude Gateway native-fork admission is now host neutral. The wider provider output stream plus
concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
