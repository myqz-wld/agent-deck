# CHANGELOG_311: Reduce recent warning/error log noise

## Summary

Recent app logs showed two actionable warning/error patterns: Monaco workers attempted to load from jsdelivr and fell back to the main thread, and the cached Codex quota app-server could be disposed by its idle timer while a reused quota read was in flight. Both are now handled locally.

## Changes

- Monaco is now configured through a lazy local helper before DiffEditor / LogViewer load `@monaco-editor/react`.
- Monaco editor workers are bundled as local Vite worker assets instead of loading from `https://cdn.jsdelivr.net`.
- Renderer CSP no longer allows jsdelivr because Monaco no longer needs a CDN fallback.
- `monaco-editor@0.55.1` is now an explicit dependency, matching the peer version used by `@monaco-editor/react`.
- Codex quota background reads now clear the cached app-server idle-dispose timer when reusing the cached client, preventing the timer from disposing an in-flight quota request.
- Regression tests cover the Codex quota idle-timer race and the DiffEditor test mock now accounts for the local Monaco helper.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts`
- `pnpm exec vitest run src/renderer/components/__tests__/NewSessionDialog.test.tsx src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx src/renderer/components/__tests__/DataPanel.test.tsx src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
