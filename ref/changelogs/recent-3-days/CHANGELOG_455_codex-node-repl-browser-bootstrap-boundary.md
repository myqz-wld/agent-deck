---
changelog_id: 455
changed_at: 2026-08-05
---

# CHANGELOG_455_codex-node-repl-browser-bootstrap-boundary: Port Browser bootstrap policy

## Summary

Codex `node_repl` Browser bootstrap selection and config rewriting now run without desktop resource
or logging singletons. The desktop adapter supplies the executable, packaged proxy path, and
bounded diagnostics through explicit ports while preserving the existing Browser process shim.

## Browser bootstrap boundary

- Moved inherited and explicit config merging, local-server eligibility, already-wrapped
  detection, null stripping, environment preservation, and proxy payload construction into a
  host-neutral policy.
- Kept effective config reads cached by exact client generation and working directory; failed reads
  are evicted for retry, while stale generation failures remain authoritative.
- Added explicit executable-path, proxy-path, and diagnostics ports. Diagnostics failures are
  contained so logging cannot change bootstrap selection or a successful thread start.
- Kept packaged resource-root resolution, the exact existing debug/warning messages, safe error
  summaries, and process executable ownership in the Electron-main adapter.

## Node boundary gate

- Added the Codex `node_repl` Browser bootstrap policy as the twenty-first executable Node 22 bundle
  candidate.
- Added a direct-import rule that rejects the desktop adapter, app-server client, diagnostics
  adapter, runtime-host, store, utilities, Node built-in imports, Electron, and `electron-log`.

## Validation

- Focused Browser policy and process-proxy coverage: passed, 2 files / 17 tests, including nine
  direct policy cases for host paths, eligibility, caching, retry, stale generations, and
  diagnostics containment.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-one Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 623 files / 4,796 tests plus 1 skipped.
- `git diff --check`, empty cached diff, changed TS/TSX line guard, and global changelog validation:
  passed; 107 structured changelogs, maximum id 455.

## Do Not Split Protection

Keep the pure bootstrap policy, desktop resource/diagnostics adapter, client wiring, direct policy
tests, process-proxy regression tests, and executable boundary gates together. Config generation,
packaged proxy identity, and thread-start rewriting form one Browser bootstrap contract.

## Remaining boundary

The Codex app-server client, MCP startup observer, thread event translator, and other provider
surfaces still own desktop logging or runtime state. Browser registry/tab ownership and the
checkpoint worker transform also remain extraction blockers. No shared development process was
started, restarted, stopped, or killed.
