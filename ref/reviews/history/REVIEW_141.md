# REVIEW_141

## Trigger Context

The user reported that the diff panel sometimes failed to show all content because the bottom line was obscured. The same request asked to upgrade Claude/Codex related dependencies.

This review covers:

- `src/renderer/components/diff/DiffViewer.tsx`
- `src/renderer/components/diff/renderers/TextDiffRenderer.tsx`
- `src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `src/renderer/components/pending-rows/diff-review-presentation.tsx`
- `src/renderer/components/pending-rows/diff-review-presentation.test.tsx`
- `package.json`
- `pnpm-lock.yaml`

Deepseek settings-path changes committed as `0a8f715` are outside this review and were not modified by this fix.

## Method

- Read repository workflow, Codex/Claude app convention assets, and related diff/dependency records.
- Inspected the `present_diff`, SessionDetail diff, Monaco diff, full-file diff, raw patch, annotation, and conflict-pane render paths.
- Queried npm registry latest versions for scoped Claude/Codex packages.
- Used package-manager lockfile updates rather than manual lockfile edits.
- Ran focused renderer, adapter, SDK/package-layout, typecheck, build, and whitespace validation.

## Gate Result

PASS.

Severity distribution:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- LOW: 1 fixed

## Decision List

### LOW fixed: scrollable diff bodies had no bottom clearance

Decision: fixed.

Evidence:

```tsx
<div className="h-full min-h-0 w-full min-w-0">
  <Comp payload={payload} />
</div>
```

```tsx
options={{
  readOnly: true,
  renderSideBySide: true,
  minimap: { enabled: false },
  fontSize: 11,
  scrollBeyondLastLine: false,
  padding: { bottom: 16 },
  automaticLayout: true,
  renderOverviewRuler: false,
}}
```

The fix applies bottom clearance at each scroll owner instead of relying on an outer margin, covering Monaco diffs, full-file add/delete panels, raw unified-diff fallback, unannotated conflict panes, and annotated code panes.

### PASS: dependency bump remained scoped

Decision: accepted as clean.

Evidence:

```json
"@anthropic-ai/claude-agent-sdk": "^0.3.195",
"@anthropic-ai/sdk": "^0.106.0",
"@openai/codex": "^0.142.3"
```

The lockfile diff only changed the scoped direct dependencies and their platform/native package entries. `@modelcontextprotocol/sdk` was checked and left pinned at `1.29.0`.

## Validation

- `pnpm exec vitest run src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx src/renderer/components/pending-rows/diff-review-presentation.test.tsx` passed: 17 tests.
- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts` passed: 23 tests.
- Installed package version checks passed for Codex `0.142.3`, Claude Agent SDK `0.3.195`, Anthropic SDK `0.106.0`, and Codex CLI `0.142.3`.
- npm latest checks confirmed the selected versions and confirmed MCP SDK remained `1.29.0`.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.

## Related Changelog

[CHANGELOG_332](../../changelogs/history/CHANGELOG_332.md).
