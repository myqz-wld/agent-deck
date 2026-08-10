---
changelog_id: 453
changed_at: 2026-08-05
---

# CHANGELOG_453_codex-usage-probe-store-boundary: Extract Codex usage probing

## Summary

Codex background quota reads now run through an explicit Node store that owns client reuse,
timeout invalidation, idle retirement, response mapping, and provider-error classification. The
desktop facade retains settings, probe cwd, process environment, and concrete app-server creation.

## Probe boundary

- Added a keyed client store with explicit client factory, cache policy, timeout, and idle-retire
  inputs.
- Preserved transient-client disposal, production client reuse, path-plus-cwd cache identity,
  timeout-triggered invalidation, and idle timer clearing while a reused read is in flight.
- Preserved the single `account/rateLimits/read` method surface and fixed unavailable/error
  projections without logging or returning raw provider data.
- Kept configured path normalization, `AGENT_DECK_ORIGIN=sdk`, probe cwd ownership, and concrete
  Codex app-server options in the desktop facade.

## Node boundary gate

- Added the Codex usage probe store as the nineteenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, app-server implementation, desktop paths,
  settings, runtime-host, and utility singleton dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed nineteen Node 22 bundle
  candidates.
- Focused store/background/facade coverage: passed, 3 files / 16 tests; the new store accounts for
  1 file / 4 tests and all 12 original cache/timeout/bridge regressions remain green.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 622 files / 4,786 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 105 structured changelogs, maximum id 453.

## Do Not Split Protection

Keep the probe store, desktop facade, cache/timeout tests, response redaction, and executable
boundary gate together. Client retirement and quota-result classification form one bounded probe
contract.

## Remaining boundary

Additional provider settings/process ownership, Browser, and checkpoint worker transforms remain
extraction blockers. No shared development process was started, restarted, or stopped.
