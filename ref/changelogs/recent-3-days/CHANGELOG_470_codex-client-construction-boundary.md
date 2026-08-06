---
changelog_id: 470
changed_at: 2026-08-05
---

# CHANGELOG_470_codex-client-construction-boundary: Port per-session client construction

## Summary

Per-session Codex app-server client construction no longer discovers desktop settings, skills,
process environment, or the desktop client factory from its Core path. A construction host now owns
that process state while cache, MCP configuration, session identity, and map registration remain an
executable Node 22 boundary.

## Host-neutral client construction

- Extracted cache lookup, CLI override normalization, MCP config merge, per-session token/origin
  injection, client option assembly, construction, and registration into `client-construction.ts`.
- Preserved zero host reads on a cache hit and the original path-before-settings read order on a
  cache miss.
- Kept the process snapshot isolated before adding `AGENT_DECK_MCP_TOKEN` and
  `AGENT_DECK_ORIGIN=sdk`, so caller environment objects are not mutated or shared across sessions.
- Registered the client only after successful construction; a thrown factory leaves the map empty.

## Explicit desktop host

- Moved settings access, process environment capture, Codex skill extra roots, and the fully
  diagnosed desktop app-server factory into `client-construction-host.ts`.
- Kept `client-registry.ts` as the stable facade for construction, idle invalidation, usage reads,
  and key rename behavior.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop construction host/factory, skills installer,
  stores, runtime host, desktop utilities, Node built-ins, Electron, and electron-log from the Core.
- Added per-session Codex client construction as the thirty-fifth executable Node 22 candidate.
- Added Core regressions for cache isolation, exact token environment, successful registration, and
  exception atomicity, plus a desktop-host ownership regression.

## Validation

- Focused construction/host, per-session identity, model, recovery, and early-error coverage:
  passed, 6 files / 82 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-five Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 639 files / 4,834 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core construction state machine, desktop host, stable registry facade, cache/token/failure
tests, direct-import rule, and bundle candidate together. The Core must not regain implicit settings,
skills, process-environment, or desktop-client discovery.

## Remaining boundary

Codex per-session client construction is now host driven. Usage/invalidation facades and several
Claude/Grok runtime paths still read desktop settings directly; Browser registry ownership and real
Linux/SSH/Feishu/provider acceptance remain outside this deterministic slice.
