---
review_id: 286
reviewed_at: 2026-09-29
baseline_commit: 94bc558daeaea6e190e390ba2eda78f4a57c0053
expired: true
---

# File Change Retrieval and Presentation Inspection

## Scope and method

Lead source inspection, authorized normalized session-event reading, regression tests, and synthetic
Browser verification. This is not an independent paired review. The expiry inventory was generated;
coverage stays expired for a future independent review.

```review-scope
src/hosts/server-core/session-event-projection.test.ts
src/main/adapters/grok-build/file-change-translate.test.ts
src/main/adapters/grok-build/file-change-translate.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/translation-types.ts
src/main/adapters/grok-build/usage-translate.ts
src/main/session/__tests__/file-change-snapshots.test.ts
src/main/session/__tests__/persist-file-change.test.ts
src/main/session/file-change-snapshots.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/session/persist-file-change.ts
src/renderer/components/SessionDetail/DiffTab.tsx
src/renderer/components/SessionDetail/RemoteDiffPanel.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/helpers.ts
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/use-file-change-payload.ts
src/renderer/components/activity-feed/file-change-context.tsx
src/renderer/components/activity-feed/file-change-row.test.tsx
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/activity-feed/rows/file-change-row.tsx
src/renderer/components/diff/ExpandedDiffOverlay.tsx
src/renderer/components/diff/file-change-reader.ts
src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.tsx
src/shared/__tests__/file-change-diff.test.ts
src/shared/file-change-diff.ts

```

## Findings and fixes

- MEDIUM: A recorded README edit already contained a Codex patch, but the activity fallback row
  exposed only its path. Add inline expansion and reuse the existing diff renderer.
- MEDIUM: Codex raw new-file text could appear as an unformatted patch, and snapshot-based additions
  could lose their label. Normalize all provider shapes and share addition/deletion badges and rows.
- MEDIUM: Independently choosing each snapshot/blob side could compare a snippet against a full
  file. Require a snapshot pair; otherwise use recorded provider data. Prefer exact provider full
  texts over a subsequently edited disk file.
- MEDIUM: Grok missed diffs on initially completed calls and emitted progress/failed proposals as
  changes. Buffer until success, retain late content, coalesce repeated files, and deduplicate them.
- LOW: Viewing a recorded edit required navigating the file list and timeline. New activity entries
  reference the stored change id directly and defer payload reads until expansion. Remote and Local
  share bounded caching and stale-result protection without crossing source/session boundaries.

## Validation

- `pnpm typecheck` passed, including both architecture guards and TypeScript projects.
- Final full `pnpm test`: 1,062 files / 6,551 tests passed; 2 files / 3 opt-in tests skipped.
- Focused final regression batch: 7 files / 51 tests passed.
- Production main, preload, and renderer build passed. The Electron SQLite binding checksum
  remained unchanged; no dependencies or native bindings were rebuilt.
- Agent Deck Browser rendered the actual Changes tab and activity components with synthetic data.
  Claude/Codex/Grok additions and deletions had identical row content, line numbers, and computed
  colors; modifications used the same Monaco viewer. The 420px viewport had 420px page width.
  Screenshots checked inline expansion and enlargement; Escape closed the overlay. The row read
  count was zero before opening and one afterward. The test tab was closed.
- Whitespace, changed-file privacy, local links, source/test size, and record buckets were checked.

One earlier full run alongside the production build failed an unchanged RemoteIssuesPanel retry
assertion. Its isolated 12-test suite passed, and the final standalone full suite passed without
changing that unrelated test or implementation.

## Fixes landed and residual risk

The fixes are present in the working tree. Full original content is available only when it was
provided or captured; legacy truncated patches and absent pre-Write content cannot be invented.
Provider kind inference retains existing snippet semantics where no explicit operation is given.
Browser exercised actual renderer components with synthetic payloads, not a restarted live backend.
New ingestion behavior is validated in tests; the running Agent Deck application remains untouched.

## Follow-ups

No required code work remains. Runtime restart requires explicit approval under Host Runtime Safety.
See [CHANGELOG_654](../../changelogs/recent-week/CHANGELOG_654_inline-file-diffs.md).
