---
review_id: 178
reviewed_at: 2026-07-27
baseline_commit: af5ecef8dc26302fad258e6930edb74740cac6f0
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_178_grok-tool-rendering-transparent-compositor: Grok tool events and transparent compositor audit

## Scope and method

Traced the supplied renderer stack overflow against the current branch, compared Grok ACP tool
events with the Claude and Codex event contract, and followed the macOS transparent-window
composition path from renderer state through the native window repaint loop.

```review-scope
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/window/lifecycle.ts
src/main/window/pin-visual.ts
src/main/window/__tests__/pin-visual.test.ts
src/renderer/components/FloatingFrame.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/describe.test.ts
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/rows/tool-row.test.tsx
src/renderer/styles/globals.css
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok ACP completion statuses were translated to `success` / `error`, while the shared Claude/Codex renderer contract expects `completed` / `failed`. A failed Grok call could therefore miss the shared failure label and error border. | Preserve ACP's canonical `completed` / `failed` statuses and add a renderer regression test for the failure treatment. |
| HIGH | Transparency had been decoupled from pinning, but the macOS 100 ms `webContents.invalidate()` loop still followed pin state only. An unpinned transparent window could retain an old compositor surface until a manual resize forced a full repaint, matching the reported text ghosting symptom. | Reconcile continuous invalidation against `alwaysOnTop || windowTransparent`, force the existing one-pixel full-compositor repaint whenever either visual state changes, and stop the loop only when both states are off. |
| MEDIUM | Grok used mutable ACP `title` patches as the tool identity and ignored ACP 1.3's programmatic `name`. Progress-title updates could make `tool-use-start` and `tool-use-end` display different names. | Prefer the initial programmatic `name`, fall back to the initial title, persist that chosen display identity by `toolCallId`, and never replace it with a later progress title. |

The supplied stack trace was produced on another machine. The current branch already contains
`10c8ddb1 fix(renderer): prevent tool alias recursion`, which replaced the `Grep` / `grep` /
`search_tool` self-recursion with a non-recursive alias resolver. That fix and its regression tests
were revalidated here; no second recursion patch was necessary.

## Evidence and validation

- `git merge-base --is-ancestor 10c8ddb1 HEAD` passed, confirming that the other-machine stack
  overflow fix is present in this source baseline.
- Focused Grok translation, window compositor, tool-row, and tool-description coverage passed:
  4 files and 40 tests.
- `pnpm typecheck` passed under the repository's Node 22 runtime.
- The full `pnpm test` suite passed 373 files and 3,119 tests, with one file and one credentialed
  test skipped.
- `pnpm build` passed and emitted the production main, preload, and renderer bundles.
- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- `git diff --check` passed.

## Fixes landed

- Stabilized Grok tool identity across start and end events and aligned its completion status values
  with Claude and Codex.
- Added ACP fixtures for mutable titles, programmatic names, completed calls, and failed
  calls, plus renderer coverage for the shared failed-tool presentation.
- Extended macOS compositor refresh to transparent-unpinned windows while preserving the existing
  opaque-pinned behavior and shutting the timer down for opaque-unpinned windows.
- Added deterministic fake-window coverage for all four pin/transparency combinations and the
  one-pixel resize repaint sequence.

## Residual risk and boundaries

- The compositor behavior is macOS/Electron-specific. Unit coverage verifies native calls, timer
  lifecycle, and the resize sequence, but final visual confirmation requires launching a rebuilt
  application on macOS and observing the formerly affected transparent mode.
- Extending the 100 ms invalidation loop to unpinned transparent windows intentionally trades a
  small amount of compositor work for fresh background surfaces. It remains disabled whenever the
  window is both unpinned and opaque.
- No paid live Grok prompt was sent; ACP translation behavior is covered with the installed SDK
  types and deterministic protocol fixtures.
- The installed Agent Deck process that owns this session also owns the single-instance lock and
  port 47821, so a development Electron process was not launched in parallel.

## Follow-ups

Install or launch a build containing this change, enable transparent mode without pinning, and
repeat the content-switching scenario that previously left text ghosts. No unresolved code defect
remains in the reviewed paths.
