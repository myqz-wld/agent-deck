---
changelog_id: 652
changed_at: 2026-09-29
---

# Session Content and Generated Images

## Summary

Improve Claude, Codex, and Grok session-detail presentation and complete supported generated-image
preview, enlargement, and local saving. Preserve the provider-specific controls and English
REASONING SUMMARY / THINKING labels confirmed by the user.

## Presentation and provider fidelity

- Consolidate matching tool starts and completions into one card, retaining original input,
  specialized Claude permission/question/plan/Agent views, output, errors, status, duration, and
  exit code. Unpaired completions do not gain a separate input entry point.
- Replace tool emoji with semantic source-owned SVGs. Simplify Shell launcher wrappers and give
  Browser commands a dedicated icon. Grok parameter summaries recognize current field aliases;
  an explicit generic `other` kind no longer masks a more specific known icon.
- Show live output, accurate failed/interrupted/cancelled turn outcomes, full compaction summaries,
  child-agent results/status, and optional background-work metadata. Retain provider warnings.
- Coalesce Codex plan and MCP progress events. Preserve Grok native plan identity, step status and
  priority, late tool arguments, and stable tool names through progress title updates.
- Open assistant messages and thought/plan rows in Markdown mode. User messages retain plaintext
  by default. Math support and its earlier validation are described in [CHANGELOG_651](CHANGELOG_651_markdown-math-rendering.md).

## Generated-image chain

- Preserve native Codex ImageGeneration/ImageView, dynamic `inputImage`, and MCP image results;
  Claude assistant/tool-result image blocks, including structured results; and Grok ACP image
  messages/tool content, including mixed raw output and progressive media.
- Extract supported bytes before persistence and IPC fan-out into host-owned content-addressed
  files. Store bounded image descriptors in activity JSON. Large unrelated output truncation
  retains image read authority and exposes a readable truncation notice.
- Bind Local and Remote image reads to the owning session's events. Remote reads enforce
  Workspace/sensitive-path rules and use bounded immutable chunks. Projections exclude internal
  source paths, and remote UI never falls back to Local assets.
- Show thumbnails, a portal lightbox with Escape/focus handling, and save actions on the card and
  preview. The native destination picker writes the original image bytes; cancellation is normal.
- Recover previews from legacy Codex records only when a valid saved path remains. Support PNG,
  JPEG, GIF, and WebP, up to 16 MiB each and eight images per event. Reject malformed/oversized data
  and avoid regexp stack exhaustion for multi-megabyte base64.

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

## Do Not Split Protection

None. Changed source/test files are at most 500 lines. Extracted image/progress/plan helpers and
split the existing large Codex/Grok translator test suites by concern without removing cases.

## Notes

The current installed application was not changed or restarted. A newly built application and
approved runtime update are required before the live host can use the main/preload changes.
Application-owned blobs currently remain after event deletion, while deletion revokes read
access. Path-backed images depend on their original file. Unsupported URL/media formats and
already-discarded historical inline bytes are not reconstructed. No database schema change.

Related [implementation review](../../reviews/recent-month/REVIEW_284_session-content-image-chain.md)
and [completed plan](../../plans/recent-month/PLAN_60_session-content-generated-images.md).
