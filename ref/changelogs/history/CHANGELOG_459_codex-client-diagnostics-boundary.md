---
changelog_id: 459
changed_at: 2026-08-05
---

# CHANGELOG_459_codex-client-diagnostics-boundary: Port Codex process diagnostics

## Summary

The Codex app-server client no longer imports the desktop logger or generic diagnostic sanitizer.
Process I/O, notification-listener, MCP-startup, and watchdog-recycle observations now cross a
failure-contained diagnostics port whose desktop adapter preserves the existing scoped messages.

## Client diagnostics boundary

- Added one complete diagnostics contract with an inert default for non-desktop clients.
- Moved interrupt-write, stderr activity, malformed stdout, notification-listener, MCP-startup,
  recycle-fence, detach-failure, termination-failure, and recycle-completion logging into the
  desktop adapter.
- Kept diagnostic payloads bounded and allowlisted: malformed stdout reports only byte count,
  process identity, and error class; stderr uses the existing sanitizer; listener errors are
  summarized only inside the desktop adapter.
- Contained every diagnostics callback so a logger failure cannot alter RPC parsing, notification
  fan-out, interrupt outcomes, process retirement, or SIGTERM-to-SIGKILL escalation.
- Preserved the same diagnostics instance when a disposed fork target creates a sibling cleanup
  client, and routed all production client factories through the desktop adapter.

## Boundary gates

- Added a direct-import rule that keeps the app-server client free of the desktop diagnostics
  adapter, logger singleton, generic diagnostic helper, stores, runtime host, and Electron.
- Added the diagnostics port as the twenty-fifth executable Node 22 bundle candidate.
- Added regressions for bounded malformed-stdout metadata, listener fan-out under diagnostic
  failure, failed interrupt writes, production client construction, and existing recycle logs.

## Validation

- Focused client, recycle, instance-pool, usage-probe, and SDK cleanup coverage: passed, 8 files /
  55 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-five Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 626 files / 4,808 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; the app-server client is 498 lines, 111 structured changelogs, maximum id 459.

## Do Not Split Protection

Keep the diagnostics port, desktop adapter, production client factories, process/recycle call sites,
regressions, and import/bundle gates together. Diagnostics must remain observational and must never
become an authority over process, generation, request, or notification state.

## Remaining boundary

The client still constructs desktop MCP, Browser-bootstrap, thread, generation-diagnostics, and
binary-resolution dependencies directly. Move those construction dependencies behind an explicit
host bundle before publishing the complete app-server client as an Electron-free Core candidate.
No shared development or Electron process was started, restarted, stopped, or killed.
