---
changelog_id: 493
changed_at: 2026-08-05
---

# CHANGELOG_493_claude-sandbox-config-core-boundary: Port sandbox policy

## Summary

Claude SDK sandbox policy no longer constructs desktop diagnostics or discovers the user home
inside its policy module. A host-neutral Core builds exact sandbox options from an injected home
and state observer while the desktop host retains bounded redacted diagnostics.

## Host-neutral sandbox Core

- Added `sandbox-config-core.ts` with the exact public mode list, excluded-command list, sensitive
  read-deny paths, workspace write roots, strict-mode policy, and unknown-mode fail-closed result.
- Injected home-directory discovery and state observation while keeping diagnostic failures unable
  to alter the returned SDK sandbox object.
- Preserved ordered writable-root deduplication, `/tmp` and Claude cache behavior, absence of an
  implicit network policy, and strict-mode prohibition of unsandboxed command fallback.

## Thin desktop host and stable facade

- Added `sandbox-config-host.ts` as the sole owner of `homedir`, the bounded state tracker, process
  run identity, safe diagnostic projection, and desktop logger sinks.
- Reduced `sandbox-config.ts` to a stable Core/Host wrapper; existing query construction and callers
  retain the same exports and call shape.
- Added direct Core and host tests while retaining hostile-input, transition, summary, recovery,
  and every diagnostic-failure seam in the existing suite.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, sessions, repositories,
  diagnostics, Electron, and electron-log from sandbox Core.
- Added Claude sandbox Core as the fifty-eighth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, sandbox, and create-failure coverage: passed, 4 files / 22 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-eight Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 682 files / 4,901 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep sandbox Core, desktop host, stable facade, direct-import rule, query caller, and policy plus
diagnostic-failure tests together. Unknown modes must remain non-reflective and fail closed, strict
mode must not acquire write roots, and diagnostics must never change SDK options.

## Remaining boundary

Claude sandbox option construction is now host neutral. Settings-environment observation,
message/permission streaming, and concrete provider composition/repository ownership remain,
alongside real Linux/SSH/Feishu/provider acceptance.
