---
changelog_id: 574
changed_at: 2026-08-07
---

# Remote Image Asset Broker

## Summary

Display Remote image file changes through the shared Diff UI without exposing Worker paths or
falling back to Local image IPC.

## Changes

- Added a desktop-only Core image-chunk method under the `assets` capability. Renderer-visible file
  payloads contain only opaque `changeId + before/after` handles; no absolute path, topology, or
  Worker-private credential crosses the protocol.
- Core rebinds every read to the authoritative session file-change row, requires both the recorded
  path and canonical target to stay inside Workspace, rejects symlink escapes and unsupported
  extensions, uses same-fd stat/read, caps images at 16 MiB, and identity-fences later chunks.
- Electron main assembles bounded 512 KiB chunks under one profile/Core-generation scope. Exact IPC
  validation rejects Local paths and forged/extra source fields.
- Added a source-qualified image-loader context to the existing Diff presentation. Local continues
  through `loadImageBlob`; Remote uses its own loader and cache namespace, including when raw
  session IDs collide across sources.

## Validation

- Focused asset, contract, Core, main, hook, and shared Session Detail tests passed 36 tests.
- The broader canonical Electron-ABI run passed 75 files / 388 tests across contracts, Server Core,
  main Remote boundaries, Remote renderer, Session Detail, and Diff; `pnpm typecheck` and
  `git diff --check` passed.

## Evidence Limits

- Only image sources authoritatively recorded inside Workspace are readable. Provider-private or
  outside-Workspace snapshot paths fail closed rather than widening the Workspace ceiling.
- Browser, worktree, remaining MCP/presentation tools, hooks, and private Grok authentication remain
  active Task 4 work. No shared process was stopped or restarted.
