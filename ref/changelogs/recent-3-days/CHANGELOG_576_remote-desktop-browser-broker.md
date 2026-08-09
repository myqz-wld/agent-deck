---
changelog_id: 576
changed_at: 2026-08-07
---

# Remote Desktop Browser Broker

## Summary

Restore the fourteen desktop Browser MCP tools for Remote provider sessions without moving
Electron browser ownership into Server Core or exposing desktop paths to the Worker.

## Changes

- Added exact `desktop.broker.next` and `desktop.broker.respond` contracts plus a bounded,
  memory-only Server Core broker. A Remote session is claimed by one exact authenticated desktop
  client identity; Feishu and cross-client responses are rejected.
- Registered all fourteen Browser tools in the private Core MCP host. Relay remains an opaque
  frame router, while the connected Electron main process long-polls, executes the existing
  Browser handlers under a source/profile/Core-generation/session-qualified owner, and returns
  bounded MCP content.
- Remote Browser navigation rejects `file://` targets. Screenshot results return only a bounded
  inline PNG and remove generated desktop artifacts; no local path, Worker-private path, or
  topology identity crosses the contract.
- Browser tabs are disposed when the owning session closes, the profile disconnects, the
  authoritative Core/generation changes, or the desktop service shuts down. Source-mode switching
  does not disconnect the transport or retire Remote browser state.

## Validation

- Focused canonical Electron validation passed 10 files / 38 tests, including contract parsing,
  Core queue identity, MCP registration, lifecycle ordering, desktop execution, and service
  integration.
- `pnpm typecheck`, both architecture gates, `pnpm build`, `pnpm verify:linux-headless`, and
  `git diff --check` passed after the final composition split.

## Evidence Limits

- Tests exercise the real Browser handler seam with deterministic fakes; they are not a live
  Electron page-navigation or screenshot acceptance run.
- Presentation, handoff, hooks, and private Grok authentication remain active Task 4 work.
- No shared Electron, SSH, Relay, Worker, or VLESS process was restarted, stopped, or killed.
