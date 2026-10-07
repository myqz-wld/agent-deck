---
review_id: 284
reviewed_at: 2026-09-29
baseline_commit: aee3d2ed2e05169efb8b730f376a26e9a0a73b62
expired: true
---

# Session Content and Image Delivery Review

This record documents inspection of the implementation working tree. Coverage stays expired
rather than granting a durable exemption from future independent review.

## Scope and method

Follow up the presentation audit and the user's direct-implementation authorization. Inspect
provider translation, ingestion, event replay, shared UI, local save IPC, and Remote image reads.
This is a source inspection with automated and synthetic Browser validation, not an independent
paired review or a live paid-provider generation test. The user excluded cross-page input lookup.

```review-scope
src/contracts/session-image-assets.ts
src/hosts/server-core/event-image-chunks.test.ts
src/hosts/server-core/event-image-chunks.ts
src/hosts/server-core/event-image-port.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/session-detail-runtime.ts
src/hosts/server-core/session-detail-text.ts
src/hosts/server-core/session-event-projection.ts
src/hosts/server-core/session-image-asset.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-tool-result.test.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/codex-cli/app-server/translate-display-items.ts
src/main/adapters/codex-cli/app-server/translate-execution.test.ts
src/main/adapters/codex-cli/app-server/translate-progress.test.ts
src/main/adapters/codex-cli/app-server/translate-progress.ts
src/main/adapters/codex-cli/app-server/translate-reasoning-collab.test.ts
src/main/adapters/codex-cli/app-server/translate-usage.test.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/grok-build/__tests__/translate-late-usage.test.ts
src/main/adapters/grok-build/__tests__/translate-usage-corrections.test.ts
src/main/adapters/grok-build/__tests__/translate-usage.test.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/adapters/grok-build/translate-content.test.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/translation-types.ts
src/main/adapters/grok-build/usage-translate.ts
src/main/ipc/__tests__/save-image.test.ts
src/main/ipc/images.ts
src/main/ipc/save-image.ts
src/main/remote-host/input-validation-session-detail.ts
src/main/remote-host/service-session-detail.ts
src/main/session/__tests__/event-images.test.ts
src/main/session/event-images.ts
src/main/session/manager-helpers.ts
src/main/session/manager.ts
src/main/store/__tests__/plan-event-update.test.ts
src/main/store/event-image-files.ts
src/main/store/event-image-repo.ts
src/main/store/event-repo.ts
src/main/store/legacy-event-image.ts
src/main/store/payload-truncate.ts
src/main/store/plan-event-update.ts
src/preload/api/misc.ts
src/renderer/components/ImageLightbox.tsx
src/renderer/components/MarkdownText.test.tsx
src/renderer/components/MarkdownText.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/activity-feed/content-presentation.test.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/image-context.tsx
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/activity-feed/rows/event-images.tsx
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/plan-progress.tsx
src/renderer/components/activity-feed/rows/simple-row.tsx
src/renderer/components/activity-feed/rows/thinking-row.tsx
src/renderer/components/activity-feed/rows/tool-end-row.tsx
src/renderer/components/activity-feed/rows/tool-result.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/shared.ts
src/renderer/components/activity-feed/tool-icon.tsx
src/renderer/components/activity-feed/tool-icons.ts
src/renderer/components/activity-feed/tool-status.ts
src/renderer/components/activity-feed/tool-summary.ts
src/renderer/components/icons/index.ts
src/renderer/components/icons/tools.tsx
src/renderer/components/markdown/math.css
src/renderer/components/markdown/remark-chat-math.ts
src/renderer/remote-host/remote-detail-readers.ts
src/renderer/stores/session-store-events.ts
src/renderer/stores/session-store-plans.test.ts
src/shared/agent-event-update.ts
src/shared/event-images.ts
src/shared/ipc-channels.ts
src/shared/remote-host/types.ts
src/shared/types/file.ts
```

## Findings and fixes

- Tool cards duplicated starts/completions and hid errors behind output. Pair only matching call
  ids, retain expandable inputs and provider-specific rows, and render output/error/status/exit
  code/duration separately. Boolean error flags no longer become failure text.
- Grok argument aliases and generic `other` hid useful summaries/icons. Prefer known semantic
  icons, retain late input/progress, and preserve the tool's stable name across title changes.
- Codex plan/MCP progress/advisory notifications were dropped. Retain and coalesce plans/progress;
  warning messages preserve current activity state. Grok plans retain native ids/status/priority.
- Generated image bytes were omitted by adapters. Preserve Codex native and dynamic `inputImage`
  content, Claude assistant and structured tool-result image blocks, and Grok ACP images even
  when `rawOutput` is also present. Grok tool progress can carry images; status-only completion
  retains them, while explicit replacement clears them.
- Bound and persist supported image bytes outside event JSON. Session-owned references authorize
  Local reads and Remote chunks; path reads obey Workspace and sensitive-path boundaries. Public
  projections keep only image metadata, never the internal source path. Legacy Codex saved paths
  can provide previews without rewriting old records.
- Multi-megabyte base64 exposed a V8 regexp-stack failure in the initial validator. Replace grouped
  repetition with a bounded flat character check and validate encoded length/padding separately.
- Preserve image read authority when unrelated tool output exceeds the activity JSON cap; show
  the retained output preview and truncation notice.
- Add image thumbnails, portal enlargement, keyboard dismissal/focus, and native save destination
  selection. Save exact bytes, treat cancellation normally, and reject symlink destinations.
- Preserve full compaction/subagent/background-work details where supplied. Keep Claude dedicated
  authorization/question/plan/Agent UI, Codex REASONING SUMMARY, and Claude/Grok THINKING.

## Validation

- `pnpm typecheck` passed, including architecture boundaries and both TypeScript projects.
- Full `pnpm test`: 1,056 files / 6,518 tests passed; 2 files / 3 opt-in tests skipped.
- After the final output-truncation adjustment, 34 targeted ingestion, payload-budget, and UI
  regressions passed. Final typecheck and production build also passed.
- Image tests cover representative Codex/Claude/Grok shapes, multi-megabyte input, malformed and
  oversized data, session isolation, legacy saved files, Workspace symlink escape, event deletion,
  bounded Remote chunks, source projection, progressive images, and explicit replacement.
- Save tests check exact bytes, cancellation, invalid URL input, and symlink destination rejection.
  UI tests cover consolidation with retained input state, outcome/error display, truncation,
  Markdown/plan labels, thumbnails, enlargement, saving, and Local/Remote reader separation.
- Agent Deck Browser rendered actual components in a synthetic local page. Screenshots confirmed
  the merged cards, semantic icons, formula layout, plan steps, and image preview. Thumbnail open,
  mocked save completion, keyboard focus/Tab, Escape, and Claude/Grok English labels were checked.
  The page width matched its 807px viewport. The background tab was closed afterward.
- `pnpm build` passed for main, preload, and renderer. Native better-sqlite3 checksum remained
  unchanged. No app lifecycle or installed-bundle action was performed.
- Review-expiry scan, source/test 500-line guard, identifying-path/token scan, and diff whitespace
  checks passed. Typed-record buckets were recomputed for 2026-09-29; no existing moves were needed.

## Residual risk and limits

- No installed app or running process was stopped, replaced, or relaunched. Main/preload and
  dependency changes require a newly built app and an approved restart/install before live use.
- Validation uses current installed provider schemas, representative payloads, real temporary
  files/SQLite, and actual renderer components with mocked image IPC in Browser. It does not prove
  every third-party tool returns a supported image shape.
- PNG/JPEG/GIF/WebP only, up to 16 MiB each and eight references per event. Remote URLs, SVG,
  audio/video, and arbitrary Markdown file links are not fetched as generated-image assets.
- Old inline bytes already discarded by prior versions cannot be reconstructed unless a valid
  saved file remains. Path-backed previews depend on the provider file remaining available.
- Application-owned image blobs are content-addressed and retained. Removing an event revokes
  read authority but does not currently garbage-collect the shared blob. No automatic deletion
  policy or database schema migration is introduced in this change.
- Event ingestion uses bounded synchronous extraction/writes to preserve event order; very large
  image batches can add ingest latency. Remote snapshots are bounded by size, count, and age.
- All changed source and test files are at most 500 lines. Two existing large adapter test suites
  were split by concern without deleting test cases; image/plan helpers live in focused modules.

## Follow-ups

No required source implementation remains after validation. Installing the new build and optional
live provider acceptance require a separate runtime action; they are not claimed as completed.

Related [original audit](REVIEW_283_session-content-presentation.md) and
[CHANGELOG_652](../../changelogs/recent-week/CHANGELOG_652_session-content-generated-images.md).
