---
changelog_id: 467
changed_at: 2026-08-05
---

# CHANGELOG_467_session-creation-defaults-core-boundary: Inject provider defaults ownership

## Summary

New-session default resolution no longer discovers the Electron settings store, desktop logger, or
Codex app-server singleton from its Core implementation. A stable desktop facade now supplies those
dependencies explicitly while the complete Claude, Codex, and Grok precedence policy is executable
as a Node 22 boundary.

## Explicit provider settings boundary

- Moved provider default layering, bounded config reads, native model/provider/approval discovery,
  sandbox normalization, timeout/abort fencing, and allowlisted diagnostics into
  `session-creation-defaults-core.ts`.
- Required the Core caller to supply the three persisted sandbox settings and the Codex effective
  config reader; host diagnostics remain optional and cannot alter fallback results.
- Kept `session-creation-defaults.ts` as the production facade that reads the desktop settings
  snapshot, requests effective Codex config, and routes semantic fallback diagnostics to the logger.
- Preserved the public IPC contract and all Claude Gateway, Codex config, Grok config, missing-file,
  invalid-data, and timeout precedence semantics.

## Dependency-graph repair

- Extracted `getCodexHome` into a small Node-only module so the config reader no longer imports the
  desktop-diagnostic plugin scanner merely to resolve `$CODEX_HOME`.
- Re-exported that helper from the former module to retain existing callers while allowing the Core
  bundle to exclude `electron-log` transitively.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop facade, settings store, Codex singleton pool,
  runtime host, desktop utilities, Electron, and electron-log from the Core resolver.
- Added the session-creation defaults resolver as the thirty-second executable Node 22 candidate.
- Added a production-host regression proving the facade supplies the settings snapshot, exact
  `config/read` request, abort signal, and path-free desktop diagnostic.

## Validation

- Focused defaults, IPC, Codex home/config/provider, and plugin coverage: passed, 6 files / 52 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 633 files / 4,823 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the host-neutral resolver, explicit settings/config/diagnostic dependencies, desktop facade,
Codex-home extraction, host regression, architecture rule, and bundle candidate together. The Core
must not regain implicit Electron settings, app-server singleton, plugin scanner, or logger access.

## Remaining boundary

Provider session-creation defaults are now host neutral. Other provider runtime paths still read the
desktop settings store directly, and Browser registry ownership plus real Linux/SSH/Feishu/provider
acceptance remain outside this deterministic slice.
