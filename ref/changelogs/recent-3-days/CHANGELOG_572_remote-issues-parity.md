---
changelog_id: 572
changed_at: 2026-08-07
---

# Remote Issues Parity

## Summary

Expose the existing Issues board and detail editor through the authenticated Remote source while
keeping the authoritative database, revisions, idempotency, and Workspace path projection in Core.

## Changes

- Added exact desktop-only Core methods for bounded Issue list/get/update/soft-delete/undelete.
  Feishu cannot call the surface; all mutations require an expected Core revision and stable
  renderer intent identity.
- Added an Electron-free Core Issue repository and projection. Host paths become Workspace-relative
  tokens, outside-Workspace paths are omitted, private roots are redacted, and result shapes and
  appendix counts are bounded before crossing SSH.
- Added exact renderer-to-main validation, IPC/preload bindings, 45-second deadlines, source/profile/
  Core-generation fences, and durable Core mutation-ledger replay semantics.
- Extracted the Local Issue board presentation and made Local and Remote use the same filters,
  rows, detail editor, evidence display, deletion controls, and edit-rebase behavior. Remote state
  stays source-qualified and never enters the Local Zustand store or calls Local Issue IPC.
- Remote list/detail reads preserve their authoritative revision. Timed-out retries reuse the same
  intent key, and late list/detail results cannot overwrite a newer mutation or another Remote
  source identity.

## Validation

- Focused closure passed 6 files / 21 tests for contracts, Core, main validation/service, header
  capability routing, and the shared Remote board/editor.
- The broad canonical Electron-ABI run passed 61 files / 298 tests across contracts, Server Core,
  main Remote boundaries, and renderer source surfaces.
- `pnpm typecheck` passed both architecture gates and both TypeScript projects; `git diff --check`
  passed, the production build and Linux headless artifact verification passed, and the Git index
  remains empty.

## Evidence Limits

- The Issue list, detail editor, updates, soft deletion, restoration, and evidence display are
  closed. Atomic “new resolution session + Issue binding” remains Task 4 work and is not replaced by
  a non-atomic renderer sequence.
- Browser/MCP/worktree/hooks/assets, image payloads, and the private Grok authentication broker are
  still active Task 4 work. No shared process was stopped or restarted and no real Linux/Full/
  Feishu acceptance is claimed.
