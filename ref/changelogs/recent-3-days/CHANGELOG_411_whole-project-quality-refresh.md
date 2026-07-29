---
changelog_id: 411
changed_at: 2026-07-29
---

# CHANGELOG_411_whole-project-quality-refresh: Harden runtime, storage, and UI boundaries

## Summary

Complete the cross-adapter quality refresh across Claude Code, Codex CLI, and Grok Build. The
release makes session creation, spawn/handoff, Browser, storage migration, renderer payloads,
logging, lifecycle cleanup, packaging, and runtime dependency handling bounded and explicit.

## Changes

### Runtime and collaboration integrity

- Make spawn collaboration setup transactional around provider creation, team membership, durable
  anchors, rollback reporting, and retry guidance. Publish one strict MCP success output schema
  through in-process, HTTP, and stdio registrations while preserving legacy JSON text.
- Fence handoff ownership, queued messages, late provider events, shutdown ingress, close epochs,
  and recently deleted app/native session identities.
- Bound Codex CLI control-plane waits and generation recovery, make Grok Build runtime mutations
  transactional, and publish Claude Code plugin mirrors through atomic directory replacement.
- Preserve adapter-owned runtime controls and canonical Claude Code, Codex CLI, and Grok Build
  names without changing protocol ids, config keys, or provider-native vocabulary.

### Storage, migration, and lifecycle

- Move the V43 History FTS rebuild behind a resumable copy-first offline migration with a durable
  journal, validation, rollback, and V54+ finalize support. Startup stops before any write when an
  existing pre-V43 database needs the command.
- Add the offline V56 pending-message ordering index after measured 1-million-row evidence. Its
  transaction verifies result parity, FIFO order, query plans, SQLite health, and crash recovery.
- Persist daily token rollups behind V55, track source revisions and dirty local days atomically,
  retain raw ranged-query truth, and coalesce renderer refresh demand.
- Page file-change summaries and patches, authorize image paths with targeted SQL, batch retention
  and lifecycle work, transact Issue appendix updates, and bound team/session/token cleanup.

### Renderer and user-facing contracts

- Add shared expandable authoring/viewer foundations for composers, plan/diff review, permissions,
  assets, application conventions, Issues, Team events/tasks, activity payloads, and image details.
- Keep heavy Monaco/image/diff views lazy, preserve draft state per surface, fence stale async
  completions, and avoid putting full provider payloads or filesystem paths in renderer state.
- Bound permission scans by bytes, JSON depth/node/rule counts, and canonical deduplication. Bound
  Issue membership projection and file-change paging without weakening user-visible retry paths.

### Diagnostics and packaging

- Add content-free run identity, safe diagnostics, bounded state-transition tracking, periodic
  suppressed-count summaries, and recovery records across provider usage, MCP startup/HTTP,
  checkpoint refresh, summarization, the main event loop, bootstrap, Electron host surfaces,
  adapter lifecycle, and configuration fallbacks.
- Harden Logs IPC around descriptor ownership, UTF-8 tail bounds, symlink swaps, close failures,
  and renderer invoke rejection.
- Declare installer production as native-host only. `dist:mac`, `dist:win`, and `dist:linux`
  reject a mismatched host before bundling platform-specific Claude Code, Codex CLI, or Grok Build
  payloads.

### Runtime dependencies

- Update Codex CLI from `0.145.0` to `0.146.0`.
- Update Grok Build from `0.2.112` to `0.2.114`.
- Confirm Claude Agent SDK `0.3.220`, Anthropic SDK `0.115.0`, MCP SDK `1.29.0`, and ACP SDK
  `1.3.0` were already the current compatible releases.

## Validation

- `pnpm typecheck`
- Focused dependency/runtime matrix: 15 files and 201 tests passed.
- Final Electron-ABI suite: 466 files passed, one intentional live smoke skipped; 3,996 tests
  passed, one skipped.
- `pnpm logger:check`
- `pnpm verify:bundled-runtimes`
- `pnpm build`
- Native `pnpm dist:mac` produced the arm64 `.app`, DMG, and block map. Packaged manifests resolve
  Claude Agent SDK `0.3.220`, Codex CLI `0.146.0`, and Grok Build `0.2.114`; all native payloads
  are present under `app.asar.unpacked`.
- `git diff --check` and the review-expiry/bucket audits passed.

## Do Not Split Protection

- Keep each offline migration's registry metadata, CLI entry, validation, swap/recovery logic, and
  failure-injection tests coupled. A partial backport can turn a safe startup refusal into an
  online rebuild or an unrecoverable swap.
- Keep MCP spawn input/output schemas, registration, structured success projection, handler
  invariants, and three-surface contract tests together.
- No changed production source file exceeds the repository's 500-line guardrail.

## Related records

- `REVIEW_187_whole-project-quality-refresh.md`
- `PLAN_23_whole-project-quality-refresh.md`
