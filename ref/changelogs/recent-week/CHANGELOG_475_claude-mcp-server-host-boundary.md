---
changelog_id: 475
changed_at: 2026-08-05
---

# CHANGELOG_475_claude-mcp-server-host-boundary: Port Claude MCP attachment

## Summary

Claude session MCP attachment no longer discovers desktop settings, constructs the in-process MCP
server, or logs attachment diagnostics from its Core path. The stable initializer now composes an
explicit desktop host around a small identity-safe Core.

## Host-neutral MCP attachment

- Extracted feature gating, disabled zero-work behavior, server attachment, and attachment
  notification into `mcp-server-core.ts`.
- Preserved the lazy `applicationSid` provider closure so MCP calls observe the current application
  session identity after the temporary-to-real session rename.
- Kept null server results diagnostic-free and returned the existing
  `{ agentDeckMcpServer }` shape unchanged.

## Explicit desktop host and stable facade

- Moved the feature setting, in-process server factory, and scoped attachment diagnostic into
  `mcp-server-host.ts`.
- Kept `mcp-server-init.ts` as the existing create-session API and retained its exact server config
  type.
- Left all MCP tool identity validation, current team membership, and transport behavior in the
  existing server implementation.

## Executable boundary gate

- Added a direct-import rule rejecting the stable initializer/desktop host, MCP server
  implementation, stores, runtime host, desktop utilities, Node built-ins, Electron, and
  electron-log from Core.
- Added Claude MCP attachment as the fortieth executable Node 22 boundary candidate.
- Added Core regressions for disabled zero-work behavior and lazy identity plus a desktop-host
  ownership regression.

## Validation

- Focused Core/host/query/create-session coverage: passed, 5 files / 28 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 649 files / 4,849 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the MCP attachment Core, desktop host, stable initializer, identity/disabled regressions,
direct-import rule, and bundle candidate together. The Core must not regain implicit settings,
desktop MCP construction, or diagnostic ownership.

## Remaining boundary

Claude MCP attachment is now host driven. Broader Claude/Codex/Grok live runtime paths still own
desktop composition directly; Browser registry ownership and real Linux/SSH/Feishu/provider
acceptance remain outside this deterministic slice.
