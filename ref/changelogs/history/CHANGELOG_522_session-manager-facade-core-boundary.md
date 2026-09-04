---
changelog_id: 522
changed_at: 2026-08-05
---

# CHANGELOG_522_session-manager-facade-core-boundary: Inject the SessionManager host

## Summary

The complete `SessionManager` public API now sits behind one host-neutral facade contract. The
desktop implementation retains its private SDK ownership, repositories, event publication, Browser
cleanup, provider hooks, and recovery state, while future Server Core composition can inject an
equivalent headless host without importing the desktop singleton.

## Facade Core

- Added `SessionManagerHost`, covering SDK claim ownership, event ingest, lifecycle operations,
  close epochs, deletion fences, identity changes, queries, and team projections.
- Added `SessionManagerFacade`, whose methods preserve exact arguments, return values, and promise
  identity while delegating to the injected host.
- Kept every mutable map and ordering decision in the existing desktop implementation; this slice
  changes only dependency direction and public construction.

## Desktop binding

- Converted the previous internal class into `DesktopSessionManagerHost` implementing the complete
  contract.
- Exported the existing `sessionManager` name as a facade over that host, leaving every caller and
  module mock compatible.
- Preserved `#sdkOwned` privacy, pending-cwd claiming, close/delete fencing, repository enrichment,
  rename hooks, and lifecycle semantics unchanged.

## Direct evidence and architecture gate

- Added direct tests covering every facade domain: SDK ownership/registration/ingest, lifecycle
  promises and projections, identity changes, queries, and team enrichment.
- Added an architecture rule rejecting desktop repositories, adapters, Browser, MCP, event bus,
  runtime hosts, diagnostics, Electron, and Electron-log from the facade Core.
- Added the facade as the eighty-sixth independently bundled Node 22 candidate.

## Validation

- Focused facade/lifecycle/manager coverage: passed, 5 files / 33 tests.
- `mise exec -- pnpm typecheck`: passed.
- Architecture and Node bundle gates passed with 86 candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 723 files / 5,012 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, and changed-file line checks passed; the facade
  Core is 167 lines, its test is 151 lines, and the desktop host remains 357 lines.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the facade contract, desktop binding, direct delegation tests, and both architecture gates
together. A partial change would either restore the desktop singleton dependency or leave provider
callers with an unverified contract.

## Remaining boundary

The injectable contract now exists, but concrete provider adapter construction still imports the
desktop `sessionManager`. The next extraction should pass `SessionManagerHost` through the adapter
composition and replace the smallest direct singleton cluster without changing provider behavior.
