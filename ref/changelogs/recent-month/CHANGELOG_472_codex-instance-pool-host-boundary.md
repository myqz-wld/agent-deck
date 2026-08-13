---
changelog_id: 472
changed_at: 2026-08-05
---

# CHANGELOG_472_codex-instance-pool-host-boundary: Port oneshot client composition

## Summary

The reusable Codex oneshot client pool no longer discovers desktop settings, process environment,
or the desktop app-server factory from its Core path. Its stable facade now composes the existing
identity store through an explicit desktop host.

## Host-neutral instance pool

- Added a Core pool factory that reads the current configured CLI path on every acquisition while
  capturing environment and constructing a client only on a cache miss.
- Preserved normalized path identity, same-path reuse, explicit invalidation, and the fail-closed
  rule that the prior client retires before a changed path can construct its replacement.
- Cloned the host environment before binding `AGENT_DECK_ORIGIN=sdk`, preventing host snapshots from
  being mutated or shared with the constructed client.

## Explicit desktop host and stable facade

- Moved settings access, process environment capture, and diagnosed desktop app-server construction
  into `instance-pool-host.ts`.
- Kept `codex-instance-pool.ts` as the stable async facade used by summarization, continuation, and
  SDK bridge callers.
- Retained `instance-pool-store.ts` as the single cache/retirement state owner.

## Executable boundary gate

- Added a direct-import rule rejecting the public facade/desktop host, app-server implementation,
  stores, runtime host, desktop utilities, Node built-ins, Electron, and electron-log from Core.
- Added the host-neutral instance-pool composition as the thirty-seventh executable Node 22 boundary
  candidate.
- Added Core and desktop-host ownership tests alongside the store and public-facade regressions.

## Validation

- Focused Core/host/store/facade and model passthrough coverage: passed, 5 files / 29 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-seven Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 643 files / 4,840 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core factory, desktop host, stable facade, identity store, retirement/order tests,
direct-import rule, and bundle candidate together. The pool must not regain implicit settings,
process-environment, or desktop-client discovery.

## Remaining boundary

Codex oneshot instance composition is now host driven. Provider-specific summarizer/runtime paths
still read desktop settings directly; Browser registry ownership and real Linux/SSH/Feishu/provider
acceptance remain outside this deterministic slice.
