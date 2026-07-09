# CHANGELOG_292 - Runtime log noise follow-up

## Summary

- `webFrameMain disposed` file-log filtering now matches Electron's real call shape: `console.error('Error sending from webFrameMain: ', error)`.
- The filter still requires both anchors in the same log call, so lone `Render frame was disposed` or lone `Error sending from webFrameMain` messages continue to pass through.
- Suppressed Monaco diff-editor unmount races now log at `debug` instead of `warn`, keeping diagnostics out of the default file log level.

## Validation

- `pnpm exec vitest run src/main/utils/__tests__/logger.test.ts src/main/utils/__tests__/logger-end-to-end.test.ts src/main/index/__tests__/bootstrap-wiring.test.ts`
- `pnpm typecheck`
