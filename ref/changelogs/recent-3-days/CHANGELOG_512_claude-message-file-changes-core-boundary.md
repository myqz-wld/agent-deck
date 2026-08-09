---
changelog_id: 512
changed_at: 2026-08-05
---

# CHANGELOG_512_claude-message-file-changes-core-boundary: Gate translated file-change state

## Summary

Claude SDK text/image tool-result bookkeeping now has an independently executable, host-neutral
Core boundary. The stable translator continues to export the existing helper names while delegating
intent and tool-name state to the new Core.

## File-change Core

- Added `message-file-changes-core.ts` with Edit/Write/MultiEdit intent construction, delayed
  completion consumption, failed-result deletion, image-tool lookup consumption, bounded image
  result parsing, and exact file-change projection.
- Preserved exactly-once intent deletion and the failure invariant: unsuccessful text or image tools
  never emit dirty file state, while every tool-result consumes its tool-name lookup.
- Preserved MultiEdit separators/count metadata and image `toolCallId` correlation.

## Stable translator and direct evidence

- Re-exported the existing public `pushFileChangeIntent` and `consumePendingFileChangeIntent` names
  from the stable translator; all production/test call sites remain unchanged.
- Reduced `sdk-message-translate.ts` from 443 to 329 lines, leaving enough line-budget for its final
  aggregate host injection without weakening the 500-line guard.
- Added direct Core tests for exactly-once MultiEdit completion, failed text/image cleanup, and
  successful image projection; retained the full delayed-intent/stream-cleanup and hook correlation
  suites.

## Executable boundary gate

- Added a direct-import rule rejecting the stable translator, concrete desktop state/runtime paths,
  Node built-ins, Electron, and electron-log.
- Added Claude translated file-change Core as the seventy-seventh executable Node 22 candidate.

## Validation

- Focused Core/translator/hook coverage: passed, 4 files / 21 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-seven Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 713 files / 4,981 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep file-change Core, stable translator exports, tool-name/intent maps, architecture rule, and
direct plus stream/hook tests together. A failed or missing tool result must never publish a file
change, and every terminal tool result must consume its bounded lookup state.

## Remaining boundary

File-change translation is independently host neutral. The 329-line message dispatcher can now be
moved behind aggregate runtime-metadata/live-rate/state/clock/identity host ports before stream
processor composition and real Linux/SSH/Feishu/provider acceptance.
