# REVIEW_126 - Runtime log warning/error triage follow-up

## Trigger Context

User asked to re-check recent application logs and not assume the earlier `webFrameMain disposed` fix was effective.

## Method

- Inspected recent runtime logs under `~/Library/Logs/Agent Deck/main-*.log`.
- Confirmed the running app process and packaged `/Applications/Agent Deck.app/Contents/Resources/app.asar` timestamp.
- Searched the packaged Electron framework for the source of `Error sending from webFrameMain`.
- Compared the Electron call shape against the current `shouldDropWebFrameMainDisposedNoise` tests and implementation.

## Findings And Fixes

### LOW-1 fixed: `webFrameMain disposed` filter missed Electron split args

Evidence: the packaged Electron framework contains:

```text
console.error("Error sending from webFrameMain: ", e)
```

The previous filter only dropped when one string item contained both `Error sending from webFrameMain` and `Render frame was disposed`. That does not cover Electron's prefix string plus `Error` object shape, even though electron-log later renders those args as one visible log line.

Fix: `shouldDropWebFrameMainDisposedNoise` now checks all data items from one log call, including `Error` objects, and drops only when both anchors are present in that same call.

### LOW-2 fixed: suppressed Monaco unmount races still filled warning logs

Evidence: `main-2026-06-18.log` had 66 `monaco unmount race (suppressed)` warnings before the app update and two more after the current package start.

Fix: both suppressed Monaco unmount race paths in `src/renderer/main.tsx` now use `logger.debug`, which stays out of the default file log level while preserving dev-console diagnostics.

## Validation

- `pnpm exec vitest run src/main/utils/__tests__/logger.test.ts src/main/utils/__tests__/logger-end-to-end.test.ts src/main/index/__tests__/bootstrap-wiring.test.ts` passed: 3 files / 35 tests.
- `pnpm typecheck` passed.

## Related Changelog

- CHANGELOG_292
