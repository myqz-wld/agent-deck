---
changelog_id: 476
changed_at: 2026-08-05
---

# CHANGELOG_476_claude-adapter-init-host-boundary: Port Claude adapter construction

## Summary

The Claude adapter facade no longer reads desktop settings or directly constructs its SDK bridge.
Adapter identity and bridge options now flow through a Node-executable Core and an explicit desktop
construction host.

## Host-neutral adapter initialization

- Added `adapter-init-core.ts` to bind the exact `claude-code` adapter identity, caller event sink,
  and host-owned permission timeout into one bridge construction request.
- Kept bridge construction single-shot within adapter initialization and preserved the existing
  initialized/not-initialized lifecycle guards.
- Used the existing SDK bridge options contract without importing its implementation into Core.

## Explicit desktop host and facade cleanup

- Moved the permission timeout setting read and concrete `ClaudeSdkBridge` constructor into
  `adapter-init-host.ts`.
- Converted the adapter facade's bridge import to type-only and removed its direct settings-store
  dependency.
- Kept hook installation, route registration, provider operations, and public adapter methods in the
  existing facade.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop host, adapter facade, SDK bridge implementation,
  stores, runtime host, desktop utilities, Node built-ins, Electron, and electron-log from Core.
- Added Claude adapter initialization as the forty-first executable Node 22 boundary candidate.
- Added Core option/identity and desktop-host ownership regressions.

## Validation

- Focused Core/host/registry/runtime-control coverage: passed, 5 files / 35 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 651 files / 4,851 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the adapter-init Core, desktop host, type-only facade dependency, identity/options tests,
direct-import rule, and bundle candidate together. The facade must not regain implicit desktop
settings or concrete bridge construction.

## Remaining boundary

Claude adapter initialization is now host driven. Codex and Grok adapter initialization plus broader
live runtime paths still own desktop composition directly; Browser registry ownership and real
Linux/SSH/Feishu/provider acceptance remain outside this deterministic slice.
