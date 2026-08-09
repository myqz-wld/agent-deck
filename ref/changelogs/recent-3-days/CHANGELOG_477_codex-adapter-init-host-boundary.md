---
changelog_id: 477
changed_at: 2026-08-05
---

# CHANGELOG_477_codex-adapter-init-host-boundary: Port Codex adapter construction

## Summary

The Codex adapter facade no longer reads desktop settings or directly constructs its SDK bridge.
Core now owns the initialization sequence while an explicit desktop host supplies settings and the
concrete bridge implementation.

## Host-neutral adapter initialization

- Added `adapter-init-core.ts` to bind the caller event sink, hook-server reference, and host-owned
  permission timeout into the existing Codex bridge options contract.
- Preserved the exact startup order: read the timeout, construct the bridge, read the CLI path, then
  apply that path to the constructed bridge.
- Kept live path updates and all other initialized/not-initialized lifecycle behavior unchanged.

## Explicit desktop host and facade cleanup

- Moved the permission-timeout and Codex CLI-path setting reads plus concrete `CodexSdkBridge`
  constructor into `adapter-init-host.ts`.
- Converted the adapter facade's bridge import to type-only and removed its direct settings-store
  dependency.
- Kept hook installation, route registration, provider operations, and public adapter methods in the
  stable facade.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop host, adapter facade, SDK bridge implementation,
  app-server, hook server, session/store/runtime hosts, utilities, Node built-ins, Electron, and
  electron-log from Core.
- Added Codex adapter initialization as the forty-second executable Node 22 boundary candidate.
- Added Core ordering/options and desktop-host ownership regressions.

## Validation

- Focused Core/host/registry/runtime-control coverage: passed, 5 files / 35 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 653 files / 4,853 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the adapter-init Core, desktop host, type-only facade dependency, initialization-order tests,
direct-import rule, and bundle candidate together. The facade must not regain implicit desktop
settings or concrete bridge construction.

## Remaining boundary

Codex adapter initialization is now host driven. Grok adapter initialization and broader live
runtime paths still own desktop composition directly; Browser registry ownership and real
Linux/SSH/Feishu/provider acceptance remain outside this deterministic slice.
