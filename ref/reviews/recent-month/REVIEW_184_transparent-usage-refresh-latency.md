---
review_id: 184
reviewed_at: 2026-07-27
baseline_commit: ebfc62ff3fb9cd16a6f8bdb16c6de7332544d716
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Changelog, review record, and bucket-index maintenance are mechanical archive work."
---

# REVIEW_184_transparent-usage-refresh-latency: Native artifacts and quota latency

## Scope and method

The investigation followed the transparent window from renderer compositing into Electron's native
macOS surface, then traced the Data-page refresh from its IPC handler through all three provider
quota readers. Production logs and the live database were inspected read-only; no user data was
modified.

```review-scope
src/main/window/pin-visual.ts
src/main/window/__tests__/pin-visual.test.ts
src/main/ipc/provider-usage.ts
src/main/ipc/__tests__/provider-usage.test.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The transparent-mode loop only called `webContents.invalidate()`. That repainted Chromium but never invoked Electron's macOS-native artifact invalidation, leaving a documented gap after the earlier CSS compositor repair. | Add `BrowserWindow.invalidateShadow()` to transparent animation frames and both sides of the existing transition resize. |
| MEDIUM | Provider quota IPC used an all-or-nothing `Promise.all` with no aggregate deadline. A 15-second background timeout or an unbounded active client therefore kept the complete Data-page refresh pending. | Apply an independent five-second deadline, reuse the last successful per-provider snapshot, and accept late successes into the cache without blocking the response. |

## Evidence and validation

- Electron documents `BrowserWindow.invalidateShadow()` as the macOS API for clearing visual
  artifacts left by transparent-window animation:
  <https://www.electronjs.org/docs/latest/api/browser-window#wininvalidateshadow-macos>.
- The production log showed Codex and Grok quota timeout sentinels in the same provider-usage fetch;
  the IPC aggregation stack was waiting on all providers.
- The production database contained 116,193 token-usage rows, while an equivalent full daily
  aggregation completed in about 0.10 seconds. This ruled out the local token query as the cause of
  the long quota refresh.
- The focused compositor and provider-usage suite passed 2 files and 14 tests, including real
  never-settling promises under fake timers.
- The full Electron-ABI suite passed 390 files and 3,286 tests; one credentialed live smoke test
  remained skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.

## Fixes landed

- Transparent mode now invalidates both the Chromium layer and the macOS native transparent
  surface; visual transitions retain the one-pixel full-layout fallback.
- Each provider has a five-second UI deadline, so two successful providers are no longer hidden by
  one hung provider.
- Timeouts preserve the last successful snapshot, while first-load timeouts surface concise
  provider-specific Simplified Chinese copy.
- Sequence guards prevent late older reads from replacing newer forced-refresh data.
- Late success after the UI deadline updates the main cache for subsequent reads.
- Changed production files remain below 500 lines.

## Residual risk

- Native visual confirmation requires launching a rebuilt app on an affected Mac. The running
  installed app was intentionally not overwritten during this session.
- The central deadline cannot cancel an adapter API because `getUsageSnapshot()` does not expose an
  abort signal. A timed-out read may finish in the background, but it no longer blocks the Data page
  and its late result is sequence-guarded.
- Electron still classifies transparent windows as a platform-limited path; the existing CSS filter
  removal and resize fallback remain necessary alongside native invalidation.

## Follow-ups

After installing a rebuilt app, continuously scroll in transparent mode and trigger repeated Data
refreshes with one provider unavailable. Confirm that text trails do not persist and the refresh
spinner clears within five seconds.
