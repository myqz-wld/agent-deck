---
plan_id: 46
completed_at: 2026-09-04
status: completed
---

# PLAN_46_compatibility-dead-code-cleanup: Remove obsolete compatibility and dead code

## Goal

Remove high-confidence obsolete compatibility and production-dead code from the four-track audit
without changing current provider recovery, security, Remote protocol, Browser CLI, upload, or
generic image-diff behavior.

## Invariants

- Keep Server Core Remote `browser_*`, the session-scoped Browser CLI/IAB, uploaded images, generic
  image file diffs, `ImageLoadBlob`, and opaque Remote image assets.
- Keep Claude/Codex/Grok identity, resume, recovery, usage reconciliation, packaged binary,
  settings/environment, handoff alias, and text `MultiEdit` behavior.
- Do not remove evidence-limited or product-undecided candidates.
- Do not stop, restart, replace, or install over a live Agent Deck process.

## Completed work

- [x] Removed Local legacy Browser MCP and its permanently false profile gate.
- [x] Removed the user-confirmed obsolete external Image MCP compatibility chain.
- [x] Removed the old optional Claude hook-id branch.
- [x] Removed confirmed-dead IPC/UI, permission, protocol, core, host, and adapter surfaces.
- [x] Retargeted retained tests to active Core/host implementations.
- [x] Used the production entrypoint graph to find and remove the retired Codex native-pipe Browser
      backend and the last two unused barrels.
- [x] Cleared stale architecture paths and proved IPC symmetry and production reachability.
- [x] Completed integrated Electron, headless, dual-architecture runtime, and deployment validation.

## Validation

- `pnpm typecheck`
- `pnpm test`: 996 files / 6,216 tests passed; 2 files / 3 opt-in tests skipped
- `pnpm build`
- `pnpm logger:check`
- Linux headless reproducible build, dual-architecture Feishu runtime build,
  `pnpm check:linux-headless`, and `pnpm check:deployment`
- Residual symbol/import graph, IPC symmetry, script existence, stale architecture paths, and
  `git diff --check`

## Deferred candidates

- Codex JSON-RPC string errors and the Grok uncompressed-binary fallback need live schema or release
  evidence before deletion.
- `FloatingWindow.flash` and the historical/future `swapLead` branch need explicit product decisions.
- Moving active test fixtures into test-support directories remains a zero-behavior structural task.

## Final status

Completed. The high-confidence cleanup is implemented and validated. A running development instance
must be restarted only after explicit user approval because main and preload code changed.

## Related final records

- `ref/changelogs/recent-3-days/CHANGELOG_638_compatibility-dead-code-retirement.md`
- `ref/reviews/recent-3-days/REVIEW_267_compatibility-dead-code-audit.md`
