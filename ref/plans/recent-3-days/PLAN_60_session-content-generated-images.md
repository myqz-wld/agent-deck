---
plan_id: 60
completed_at: 2026-09-29
status: completed
---

# Session Content and Generated Images

## Goal and authorization

Implement the remaining recommendations in
`ref/reviews/recent-week/REVIEW_283_session-content-presentation.md`, plus generated-image
preview, enlargement, and local saving. The user explicitly selected direct implementation
under the already confirmed scope instead of the full planning-skill workflow.

## Invariants and scope

- Keep Codex `REASONING SUMMARY` and Claude/Grok `THINKING` in English.
- Do not add cross-page input retrieval or an extra unpaired-completion input entry point.
- Preserve Claude permission/question/plan interactions and Agent/Task-specific detail.
- Retain raw input/output while consolidating reliably paired tool rows.
- Preserve the existing, validated math-renderer changes and their pending documentation.
- Keep Local and Remote asset authority separate; UI-supplied paths cannot authorize reads.
- Do not put generated image base64 into normal activity history. Store bounded binary assets
  through an owned host path and send bounded references to the renderer.
- Saving uses an explicit user action and a native destination picker. Never silently overwrite
  an arbitrary destination or fetch arbitrary provider URLs.
- Do not restart, stop, reinstall, or replace the live Agent Deck host without exact approval.
- Work in the current checkout, preserving unrelated changes. No delegates have been started.

## Decisions

- Direct implementation is user-confirmed.
- Generated images must render in session detail, open in an enlarged view, and save locally.
- Reuse the source-owned SVG primitive; add only the required semantic icons.
- Prefer existing event kinds and asset mechanisms when their ownership contract fits. Do not
  misrepresent generated media as a source-file edit merely to obtain a read capability.
- Existing math syntax and source/plaintext toggles remain available.

## Tasks

1. **Completed: trace generated-media ownership and persistence.** Inspect adapter translation,
   event ingestion, Local image IPC, Remote image contracts, and current lightbox/cache.
2. **Completed: shared presentation.** Pair tool rows; separate output/error/status; show live output,
   subagent summaries, compaction details; simplify summaries; introduce semantic SVGs.
3. **Completed: provider event fidelity.** Codex plan/MCP progress/actionable warnings; Grok structured
   plan status/priority, late tool arguments, and supported media. Coalesce updates predictably.
4. **Completed: image lifecycle and UI.** Preserve Codex native and tool-returned images, Claude assistant/tool-result images, and Grok
   image content, bind reads to session events, preview/enlarge/save with Local/Remote routing.
5. **Completed: validation and records.** Focused regression tests, architecture/typecheck, full
   Electron-compatible suite, build, Browser fixture visual checks, changelog/review/plan archive.

## Evidence gathered

- `translate-display-items.ts` emits ImageGeneration `savedPath` and `hasInlineResult`, discarding
  inline bytes. Tool result rows currently format that metadata as text.
- Local `ImageLoadBlob` reads only file-change-authorized paths. `UploadedImageLoad` only reads
  user-upload storage and applies a 14-day reaper; generated history needs an explicit contract.
- Remote image reads currently use file-change id/side handles with chunked, bounded access;
  ordinary Remote events redact binary fields and strip user attachments.
- ImageLightbox supports existing uploaded paths and already-loaded data URLs, but no save action.
- The central Desktop ingest pipeline is `src/main/session/manager-ingest-pipeline.ts`.
- Selected design: content-addressed files under host-owned `event-images`, with references in
  existing events. No database schema change. Local reads and Remote chunk reads resolve image
  ids against the requested session's durable events; Remote path reads enforce Workspace and
  sensitive-path rules. Remote projections remove internal source paths.
- Codex protocol fields were checked using the installed CLI's generated JSON schema, stored
  temporarily in `.ref/codex-display-schema`. MCP progress uses itemId/message; plans use turnId.
- First regression batches passed: 74 content/provider/media tests and 10 save/Remote/progress tests.

## Validation and risks

- Verify session-bound reads, traversal/symlinks, oversized/malformed data, missing files,
  cross-source isolation, cancel-save, and stable image cache keys.
- Verify replay and incremental updates do not duplicate tool/plan/progress rows or drop output.
- Verify failures/cancellations, provider-specific controls, and terminal Hook optional fields.
- Build and test without modifying the installed application or swapping its native binding.

## Final handoff

Source implementation, automated validation, synthetic Browser checks, and final records are
complete. No unresolved user-owned product decision remains. Main/preload and dependency changes
require a newly built app and a separately approved runtime update before live use. The installed
application and its processes remain untouched.

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

See [CHANGELOG_652](../../changelogs/recent-3-days/CHANGELOG_652_session-content-generated-images.md)
and [REVIEW_284](../../reviews/recent-3-days/REVIEW_284_session-content-image-chain.md) for delivery
evidence, retained-blob behavior, historical-image limits, and the exact validation scope.
