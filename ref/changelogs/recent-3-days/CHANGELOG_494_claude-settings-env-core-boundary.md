---
changelog_id: 494
changed_at: 2026-08-05
---

# CHANGELOG_494_claude-settings-env-core-boundary: Port settings environment policy

## Summary

Claude settings-environment parsing and allowlist policy no longer owns desktop filesystem,
process-environment, or diagnostic dependencies. A host-neutral Core classifies the settings
document and orders assignments while a desktop host supplies every external effect.

## Host-neutral settings Core

- Added `settings-env-core.ts` with the exact `ANTHROPIC_`/`CLAUDE_` and proxy-key allowlist,
  object/string validation, source-order assignments, rejected/applied accounting, and fixed
  healthy/rejected/read-failed states.
- Kept the file-existence probe outside the historical read/assignment swallow boundary while
  preserving completed assignments when a later environment write fails.
- Bounded diagnostic counts at 10,000 without truncating assignments and made every observer
  failure unable to alter environment policy or its existing fallback.

## Thin desktop host and stable facade

- Added `settings-env-host.ts` as the sole owner of settings-path discovery, synchronous file I/O,
  `process.env` assignment, bounded state tracking, process run identity, safe diagnostics, and
  desktop logger sinks.
- Reduced `settings-env.ts` to a stable Core/Host wrapper, preserving bootstrap ordering and the
  existing public call shape.
- Added direct Core and host tests while retaining all 22 missing/read/parse/assignment/order,
  transition, count-bound, redaction, and diagnostic-failure tests.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, Node built-ins, sessions,
  repositories, diagnostics, Electron, and electron-log from settings-environment Core.
- Added Claude settings-environment Core as the fifty-ninth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, settings, and bootstrap coverage: passed, 4 files / 26 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-nine Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 684 files / 4,904 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep settings Core, desktop host, stable facade, bootstrap caller, direct-import rule, and policy
plus diagnostics tests together. The existence probe must remain outside the read/assignment catch,
assignments must preserve source order, and raw keys, values, paths, or failures must never enter
diagnostics.

## Remaining boundary

Claude settings-environment policy is now host neutral. Message/permission streaming and concrete
provider composition/repository ownership remain, alongside real Linux/SSH/Feishu/provider
acceptance.
