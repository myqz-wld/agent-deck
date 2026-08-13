---
changelog_id: 553
changed_at: 2026-08-05
---

# CHANGELOG_553_codex-sdk-bridge-runtime-host-boundary: Bundle the complete Codex SDK bridge

## Summary

The complete Codex SDK bridge is now an executable Node 22 boundary candidate. One explicit runtime
host supplies its desktop-owned session, token, persistence, configuration, client-registry,
handoff, worktree, upload, Browser, and diagnostic dependencies without changing bridge behavior.

## Aggregate runtime host

- Added a host-neutral contract for the exact concrete services consumed throughout the bridge.
- Added one desktop composition that delegates to the authoritative SessionManager, MCP token map,
  repositories, configuration readers, client registry, handoff/worktree guards, upload cleanup,
  Browser ownership, and scoped diagnostics.
- Threaded the required host through create, resume, fork, recovery, restart, message, finalization,
  retirement, and thread-loop controllers rather than allowing nested modules to rediscover
  desktop singletons.
- Kept live token-rate, model-option, runtime-selection, persistence, and recovery decisions behind
  their existing pure Core policies while supplying concrete effects from the aggregate host.

## Complete-bridge boundary

- Added the complete Codex SDK bridge to the executable Node 22 bundle gate.
- Increased the stable candidate inventory from 93 to 94.
- Added an architecture rule preventing the bridge from importing its desktop runtime host; only
  adapter initialization may construct and inject that host.
- Added a reusable test runtime host so focused controller tests exercise the same explicit contract
  without importing desktop persistence or Electron composition.

## Preserved behavior

- Codex thread identity, creation/resume/fork ordering, recovery, cancellation, lifecycle claims,
  publication, and app-server authority remain unchanged.
- MCP session-token allocation, resolution, and release still use the authoritative desktop token
  store and retain their existing cleanup order.
- Session model updates, usage-rate observation, persisted fields, handoff admission, pending
  worktree transitions, upload cleanup, and Browser disposal retain their existing implementations.
- This slice has no user-visible UI or protocol change.

## Validation

- Complete Node boundary gate: passed, 94 executable candidates.
- Codex adapter and SDK bridge coverage: passed, 74 files / 478 tests.
- Node and web TypeScript plus architecture gates passed.
- `mise exec -- pnpm build`: passed; main production bundle transformed 788 modules.
- Canonical Electron full suite: passed, 742 files plus 1 skipped / 5040 tests plus 1 skipped.
- `index.ts`, `recover-and-send-impl.ts`, and `thread-loop.ts` are 499 lines;
  `runtime-host-core.ts` is 109 lines and `runtime-host.ts` is 78 lines.
- `git diff --check` passed and the cached Git index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the aggregate contract, desktop composition, adapter injection, architecture prohibition,
test fixture, and complete-bridge executable candidate together. Removing any one of them would
either hide a desktop dependency again or leave the Node boundary unproved.

## Remaining boundary

The next extraction target is the concrete provider settings/composition and repository ownership
needed by an Electron-free Server Core. Real Linux/native packaging, SSH/Podman/systemd acceptance,
and live Feishu/provider acceptance remain explicitly separate environment-bound gates.
