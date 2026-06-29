# CHANGELOG_332: Diff panel bottom padding and Claude/Codex dependency bump

## Summary

Diff panels now keep the final line clear of the bottom edge, and the bundled Claude/Codex runtime dependencies have been updated to the latest npm stable versions verified on 2026-06-29.

## Changes

- Added a stable `h-full min-h-0 w-full min-w-0` wrapper around `DiffViewer` renderer output so embedded diff renderers receive a complete height and width chain.
- Added bottom scroll padding for text diff render paths:
  - Monaco diff editor gets `padding.bottom = 16`.
  - Whole-file add/delete panels keep `pb-5` inside the scrollable content.
  - Raw unified-diff fallback panes keep `pb-6`.
- Updated MCP `present_diff` display panes so PR diffs, JSON fallback, unannotated conflict panes, and annotated code panes all leave bottom scroll room.
- Added renderer tests covering Monaco bottom padding, full-file/raw fallback padding, and unannotated conflict pane padding.
- Upgraded scoped Claude/Codex dependencies:
  - `@anthropic-ai/claude-agent-sdk`: `^0.3.187` -> `^0.3.195`.
  - `@anthropic-ai/sdk`: `^0.105.0` -> `^0.106.0`.
  - `@openai/codex`: `^0.142.0` -> `^0.142.3`.
- Confirmed `@modelcontextprotocol/sdk` registry latest remains `1.29.0`, so it was left unchanged.

## Validation

- `npm view @anthropic-ai/claude-agent-sdk version` -> `0.3.195`
- `npm view @anthropic-ai/sdk version` -> `0.106.0`
- `npm view @openai/codex version` -> `0.142.3`
- `npm view @modelcontextprotocol/sdk version` -> `1.29.0`
- `node -p "require('./node_modules/@openai/codex/package.json').version"` -> `0.142.3`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"` -> `0.3.195`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"` -> `0.106.0`
- `./node_modules/.bin/codex --version` -> `codex-cli 0.142.3`
- `pnpm exec vitest run src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx src/renderer/components/pending-rows/diff-review-presentation.test.tsx` passed: 17 tests.
- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts` passed: 23 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
