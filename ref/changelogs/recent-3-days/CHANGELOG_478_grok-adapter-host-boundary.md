---
changelog_id: 478
changed_at: 2026-08-05
---

# CHANGELOG_478_grok-adapter-host-boundary: Port Grok adapter composition

## Summary

The Grok adapter facade no longer reads desktop settings or imports resource composition directly.
Core now owns bridge option policy and create-time sandbox precedence while an explicit desktop host
supplies settings, resources, and the concrete bridge.

## Host-neutral adapter composition

- Added `adapter-host-core.ts` to construct the Grok bridge with dynamic MCP, application prompt,
  plugin-directory, capability, timeout, and binary-path policy.
- Preserved short-circuit setting reads, bundled-agent injection, explicit plugin ordering and
  deduplication, plus live callback evaluation for subsequent sessions.
- Preserved create-time sandbox precedence exactly: explicit values including `null`, then no
  override for resume, then the desktop default for a new session.

## Explicit desktop host and contract

- Added `adapter-host.ts` to own Grok settings, resource loading/profile preparation, and the
  concrete `GrokBuildBridge` constructor.
- Moved the bridge option interface into `bridge-options.ts`, retained its stable export from the
  bridge, and converted the facade bridge dependency to type-only.
- Kept route/installer ownership, capability state mutation, probing, and public lifecycle methods
  in the existing facade.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop host, facade, bridge implementation, resources,
  session/store/runtime hosts, utilities, Node built-ins, Electron, and electron-log from Core.
- Added Grok adapter composition as the forty-third executable Node 22 boundary candidate.
- Added Core policy/short-circuit/precedence and desktop-host ownership regressions.

## Validation

- Focused Core/host/session-setup/registry/runtime-control coverage: passed, 6 files / 38 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 655 files / 4,856 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the adapter-host Core, desktop host, bridge-options contract, type-only facade dependency,
policy regressions, direct-import rule, and bundle candidate together. Grok session injection and
sandbox defaults must not regain implicit desktop discovery in the facade.

## Remaining boundary

Claude, Codex, and Grok adapter construction is now host driven. Claude SDK injection and broader
live runtime/repository paths still own desktop composition directly; Browser registry ownership
and real Linux/SSH/Feishu/provider acceptance remain outside this deterministic slice.
