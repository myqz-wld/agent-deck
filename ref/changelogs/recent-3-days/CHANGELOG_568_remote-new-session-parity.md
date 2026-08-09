---
changelog_id: 568
changed_at: 2026-08-07
---

# Remote New Session Parity

## Summary

Use one New Session experience for Local and Remote sources, with Core-owned creation choices,
Workspace-relative directory browsing, and bounded initial image transfer.

## Changes

- Replaced the separate Remote creation dialog with the shared Local New Session presentation.
  Remote adapters, providers, models, thinking levels, permission/session modes, approval policy,
  sandbox choices, defaults, disabled reasons, and attachment policy come from one revisioned Core
  capability descriptor.
- Added the desktop-only `workspace.directory.list` contract. Server Core returns only canonical
  direct subdirectories as relative references, with exact bounds and deterministic sorting; files,
  symlinks, escaped paths, unsafe names, and absolute host paths are never projected.
- Extended `session.console.create` with the exact Local-equivalent option set, capability revision,
  and bounded inline images. Core revalidates every option and Workspace directory before provider
  creation and stores images under private quota-bound state with exclusive 0600 writes.
- Preserved source/profile/Core-generation fences across capability reads, directory navigation,
  create retries, and source switches. Large image bodies are replaced with SHA-256 digests only for
  renderer intent identity, so retry deduplication remains content-bound without exceeding its key
  ceiling.
- Kept Feishu on authoritative Core defaults while sharing the same create descriptor and
  Workspace resolution. Directory enumeration remains desktop-only and no new host path crosses the
  Feishu or renderer boundary.

## Validation

- `pnpm typecheck` passed both architecture checks and Node/web TypeScript checks.
- The related Electron-ABI run passed 66 files and 372 tests.
- The complete canonical Electron suite passed 785 files and 5,220 tests, with one existing skipped
  file/test and zero failures.
- `pnpm build` completed the main, preload, and renderer production bundles.
- `git diff --check` and the changed TypeScript/TSX 500-line guard passed.

## Evidence Limits

- The shared dev/Electron process was deliberately not restarted, per the active process-safety
  instruction; main/preload behavior is validated by tests and build rather than a restarted UI.
- This change mirrors creation controls and preserves the existing Workspace boundary. The next
  task still owns complete provider-policy compilation and cross-platform sandbox canaries.
- Real Linux Full/Relay, live provider, and live Feishu acceptance are not claimed by this record.

## Do Not Split Protection

No changed TypeScript or TSX file reaches 500 lines. The largest changed implementation file is
`src/renderer/remote-host/use-remote-session-source.ts` at 495 lines; extend it by extracting a
same-directory action module first.
