---
changelog_id: 570
changed_at: 2026-08-07
---

# Remote Summary and Text-Diff Parity

## Summary

Expose session summaries and bounded text file changes through the authenticated Remote data
source while keeping every path relative to Workspace and preventing Local fallback.

## Changes

- Added exact Core contracts and capabilities for summary listing, file-change paging and payloads,
  and final diffs. The new methods are desktop-only, revision-bounded, and reject extra or malformed
  response fields before they cross the SSH bridge.
- Wrapped the headless Server Core runtime with Workspace authority checks. Absolute stored paths
  are verified against the session directory and projected to Workspace-relative POSIX tokens;
  metadata, summary content, snapshots, and final diffs have explicit byte and count ceilings.
- Added Electron main, IPC, preload, and renderer adapters with source/profile/Core-generation
  fences. Remote Session Detail reuses the existing Summary presentation and Diff tab components,
  but all data and actions are dispatched through Remote APIs.
- Kept image changes unavailable until the Remote asset broker is implemented. This deliberately
  prevents Worker image paths from reaching the Local image IPC or renderer.
- Extracted file-change read diagnostics behind a Core-safe observer port so the Server Core bundle
  remains Electron-free while desktop and headless hosts retain bounded warnings.

## Validation

- `pnpm check:architecture` passed both architecture and Core Node-boundary gates.
- Node and renderer TypeScript projects passed with `--noEmit`.
- The canonical Electron-ABI focused run passed 38 files and 201 tests, including SQLite-backed
  repository composition, Server Core runtime projection, IPC validation, and Remote UI fencing.
- `git diff --check` passed, and every changed ordinary TypeScript/TSX file remains below 500 lines.

## Evidence Limits

- This slice covers summary and text-diff reads only. Remote image assets, events, tasks/issues,
  Browser/MCP/worktree/hooks, and the Grok credential broker remain in active Task 4.
- No shared development process was stopped or restarted, and no real Linux/Full/Feishu acceptance
  is claimed by this static and Electron-runner closure.
