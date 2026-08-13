---
changelog_id: 460
changed_at: 2026-08-05
---

# CHANGELOG_460_codex-app-server-process-host-boundary: Inject Codex process startup

## Summary

The Codex app-server client no longer resolves desktop binaries, mutates helper PATH state, or calls
`spawn` directly. An explicit client host starts the child, while the desktop process adapter owns
override normalization, packaged fallback discovery, helper-path injection, cwd, argv, and stdio.

## Process host boundary

- Added a client-host contract that combines the failure-contained diagnostics surface with one
  explicit process-start port and a fail-closed unconfigured default.
- Moved executable override trimming, packaged/default binary precedence, bundled helper PATH
  injection, environment copying, fixed `app-server --stdio` argv, cwd, and piped stdio into the
  desktop process adapter.
- Kept environment mutation private to the spawned child; the caller-owned environment snapshot is
  never modified by helper-path injection.
- Preserved the concrete host when fork rollback creates a sibling cleanup client, so diagnostics,
  binary resolution, and process startup cannot silently change between generations.
- Kept stdout framing, stderr bounding, request ownership, generation fencing, and child retirement
  in the host-neutral app-server client.

## Boundary gates

- Strengthened the client import rule to reject the desktop process adapter and Codex binary facade
  in addition to logger, diagnostic, store, runtime-host, and Electron dependencies.
- Added the client-host port as the twenty-sixth executable Node 22 bundle candidate.
- Added explicit-override, packaged-resolution, helper-PATH isolation, and PATH-command fallback
  regressions using injected process dependencies rather than a real child.

## Validation

- Focused process-host, diagnostics, recycle, instance-pool, usage, and SDK cleanup coverage:
  passed, 7 files / 45 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 627 files / 4,811 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; the app-server client is 490 lines, 112 structured changelogs, maximum id 460.

## Do Not Split Protection

Keep the client-host contract, desktop process adapter, production factory, client process call
site, exact argv/PATH tests, and import/bundle gates together. Process startup is host authority;
the protocol client must not rediscover desktop paths or construct an alternate child.

## Remaining boundary

The client host still needs to absorb the remaining concrete desktop generation diagnostics, MCP
observer, Browser bootstrap, and thread factory dependencies before the complete app-server client
can become an Electron-free Core candidate. No shared development or Electron process was started,
restarted, stopped, or killed.
