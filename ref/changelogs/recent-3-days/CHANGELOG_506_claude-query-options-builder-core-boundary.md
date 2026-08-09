---
changelog_id: 506
changed_at: 2026-08-05
---

# CHANGELOG_506_claude-query-options-builder-core-boundary: Port SDK option policy

## Summary

Claude SDK query-option construction now runs in a host-neutral Core. The stable desktop facade
supplies only the app-owned MCP tool namespace; all permission, environment, model, plugin, hook,
sandbox, binary, and resume semantics remain unchanged.

## Host-neutral query-options Core

- Added `query-options-builder-core.ts` with the complete fixed SDK baseline, including permission
  defaults, exact `bypassPermissions` elevation, preset system prompt, native settings sources,
  partial-message streaming, resume, runtime executable, and `AGENT_DECK_ORIGIN=sdk` ownership.
- Preserved conditional Gateway settings, unpacked Claude binary, model/effort, native agent and
  agent definitions, runtime hooks, sandbox settings, and session-local MCP server projection.
- Replaced the concrete main-process MCP server import with one required host-supplied tool pattern;
  Core cannot invent or widen the desktop tool namespace.

## Thin desktop facade

- Reduced `query-options-builder.ts` to a compatibility facade that injects the single canonical
  `AGENT_DECK_MCP_TOOL_PATTERN` and retains the original function and argument type.
- Removed Core type dependencies on concrete sandbox, SDK-injection, child-runtime, and MCP-server
  facades by using the SDK's structural option types directly.
- Added direct Core tests for the fixed baseline, exact bypass gate, MCP pattern injection, and all
  session-local option families; added a facade regression pinning `mcp__agent-deck__*`.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, sandbox/injection/runtime facades, MCP
  server, concrete stores/runtime utilities, Node built-ins, Electron, and electron-log from query
  options Core.
- Added Claude query-options Core as the seventy-first executable Node 22 boundary candidate.

## Validation

- Focused Core/facade/create-session/runtime coverage: passed, 6 files / 42 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 706 files / 4,955 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep query-options Core, desktop facade, MCP-pattern injection, direct-import rule, and both test
layers together. `bypassPermissions` must remain exact, disabled MCP must expose no allowed tool,
and the child origin, settings, binary, sandbox, model, agent, hook, and resume options must remain
session local.

## Remaining boundary

Claude SDK query-option policy is now host neutral. Provider output streaming plus concrete
create/recovery composition and repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
