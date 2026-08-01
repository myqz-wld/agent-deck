---
review_id: 179
reviewed_at: 2026-07-27
baseline_commit: 753bff9a15f11bbeaf2c4d7c6359fe06465ee9e0
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_179_transparent-scroll-compositor: Transparent scroll compositor audit

## Scope and method

Traced the persistent scroll ghosting in macOS transparent mode from the scroll container through
Chromium's compositor and the transparent native window. The reproduction used the repository's
Electron runtime, a minimal transparent `BrowserWindow`, the production frame styles, and Chrome
DevTools Protocol `LayerTree` paint counters. Variants removed isolation and backdrop filtering
independently so that the repair followed the observed compositor boundary rather than the resize
symptom alone.

```review-scope
src/main/window/pin-visual.ts
src/renderer/components/FloatingFrame.tsx
src/renderer/styles/globals.css
src/renderer/styles/globals.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Transparent mode retained `backdrop-filter: blur(18px) saturate(160%)` on the full-window frame. Chromium promoted that frame to a full-size `BackdropFilter` compositor layer even though Electron cannot blur other applications through a CSS filter. Scroll frames repainted inside Chromium, but the extra filter render pass was the boundary that could remain stale when submitted through the macOS transparent window; resizing rebuilt the native surface and cleared it. | Set both backdrop-filter properties to `none` only in transparent mode, remove the filter from that mode's transition, and add a stylesheet regression test. Opaque mode keeps its existing vibrancy and CSS filtering. |

## Evidence and validation

- Electron's transparent-window documentation states that CSS blur applies only to the window's web
  contents and cannot blur content below the window, including other applications:
  <https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations>.
- Electron separately documents that transparent `BrowserWindow`s can leave visual artifacts on
  macOS:
  <https://www.electronjs.org/docs/latest/api/browser-window#wininvalidateshadow-macos>.
- With the former production filter, `LayerTree` reported a 1040 x 1360 full-window layer whose
  compositor reason included `BackdropFilter`.
- Across 60 smooth-scroll frames, that layer's paint count advanced from 1 to 60. A subsequent
  `webContents.invalidate()` advanced it to 61. This rules out missing scroll events, stale React
  data, renderer throttling, and failure to request a Chromium repaint; invalidation only repainted
  the same filtered render pass.
- Removing only `isolation` retained the full-window `BackdropFilter` layer. Removing only the
  backdrop filter removed it, distinguishing this defect from the previously fixed
  mix-blend/isolation path.
- Loading the repaired production stylesheet produced a computed filter of `none` and no
  `BackdropFilter` compositor reason before or after another 60-frame smooth scroll.
- `webContents.capturePage()` contained the current scrolled content. OS-level capture was blocked
  by macOS Screen Recording permission, so native visual confirmation remains a release validation
  step rather than evidence claimed by this review.
- `pnpm typecheck` passed under the repository's Node 22 runtime.
- The full `pnpm test` suite passed 373 files and 3,120 tests, with one file and one credentialed
  test skipped.
- `pnpm build` passed and emitted the production main, preload, and renderer bundles.
- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- `git diff --check` passed.

## Fixes landed

- Removed the full-frame backdrop-filter render pass from transparent mode while retaining the
  intended alpha background and shadows.
- Limited the transparent-mode transition to background and shadow properties so entering the mode
  drops the filtered layer synchronously.
- Added a regression test that rejects either prefixed filter reintroduction, blur filters, or a
  backdrop-filter transition in the transparent rule.
- Corrected renderer and native-window comments so the periodic invalidation loop is documented as
  a surface-liveness fallback, not the root fix for scrolling artifacts.

## Residual risk and boundaries

- The defect is specific to the macOS transparent native-window presentation path. The exact
  offending Chromium layer is absent after the repair, but the rebuilt application should still be
  exercised on an affected machine because this process lacked Screen Recording permission for an
  OS-level before/after capture.
- The existing 100 ms invalidation loop remains enabled for transparent or pinned windows as a
  conservative native-surface liveness fallback. It no longer repeatedly repaints a full-window
  backdrop-filter render pass.
- Opaque mode is unchanged and continues to use macOS vibrancy plus the existing CSS filter.

## Follow-ups

Launch a build containing this review, enable transparent mode, and continuously scroll the content
on a previously affected Mac. Confirm that content no longer leaves persistent trails and that no
resize is needed to refresh the window.
