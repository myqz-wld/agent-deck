---
changelog_id: 462
changed_at: 2026-08-05
---

# CHANGELOG_462_codex-app-server-client-host-boundary: Publish the Codex client candidate

## Summary

The Codex app-server client no longer imports the desktop Browser-bootstrap adapter or desktop
thread factory. Those construction decisions now come from the explicit client host, and the full
client is published as an executable Electron-free Node 22 boundary candidate.

## Complete client host boundary

- Extended the client host with thread construction and thread-option preparation ports.
- Kept a host-neutral default thread factory for direct Node consumers while the desktop host
  supplies watchdog diagnostics through the existing desktop thread factory.
- Moved Browser bootstrap selection into the desktop host without changing the explicit
  `nodeReplBrowserBootstrap` eligibility gate in the client.
- Preserved start, resume, adopted-generation attachment, initial runtime identity, Browser config
  reads, generation operations, watchdog deadlines, and no-replay behavior.
- Updated tests that intentionally assert desktop Browser or watchdog logging to request the
  desktop host explicitly; host-neutral clients remain silent and do not discover desktop assets.

## Executable boundary gate

- Strengthened the client direct-import rule to reject desktop thread and Browser adapters.
- Added the complete Codex app-server client, including its host-neutral default host and thread
  state machine, as the twenty-seventh executable Node 22 bundle candidate.
- Added direct regressions proving start/resume/adopt construction arguments and Browser option
  preparation cross the supplied host unchanged.

## Validation

- Focused client-host, Browser policy/integration, thread, and watchdog coverage: passed, 5 files /
  56 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-seven Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 627 files / 4,814 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; the app-server client is 488 lines, 114 structured changelogs, maximum id 462.

## Do Not Split Protection

Keep the host thread/Browser ports, desktop composition, client call sites, explicit-host tests, and
complete-client bundle gate together. A host-neutral client must never fall back to desktop assets,
while desktop callers must retain their watchdog diagnostics and Browser bootstrap behavior.

## Remaining boundary

The complete Codex process client now bundles under plain Node, but the larger concrete Core still
needs provider settings/composition, Browser registry/tab ownership, authoritative repositories,
and the Electron-Vite checkpoint-worker transform removed or ported. No shared development or
Electron process was started, restarted, stopped, or killed.
