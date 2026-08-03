---
review_id: 173
reviewed_at: 2026-07-26
baseline_commit: 181a79564a1ec15f42614eccbc7745214dcd4e29
expired: false
---

# REVIEW_173_tool-input-alias-recursion: Renderer tool-summary recursion audit

## Scope and method

Investigated the reported renderer stack overflows in `describeToolInput` and
`summariseToolInput`, traced both component stacks to their shared Grep alias behavior, and added
regression coverage for the canonical and adapter-specific tool names before validating the
production renderer bundle.

```review-scope
src/renderer/components/SessionCard.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/describe.test.ts
```

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Both tool-summary implementations lowercased `Grep` to `grep`, matched the alias branch, and recursively called themselves with `Grep` again. Any object input for `Grep`, `grep`, or `search_tool` could therefore overflow the renderer stack in either SessionDetail or SessionList. | Replace recursive alias handling with one shared, non-recursive canonical-name resolver and switch directly on the resolved name. |

## Evidence and validation

- The supplied logs repeat the same recursive frame under both `ToolStartRow` and `SessionCard`;
  the first frame enters at `String.trim`, matching alias normalization before the recursive call.
- Regression coverage exercises `Grep`, `grep`, and `search_tool` through both the ActivityFeed
  describer and SessionCard summarizer.
- Targeted renderer validation passed: 3 files, 53 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed and emitted the production renderer bundle.
- `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed before final review.
- `pnpm test` reached 3,089 passing tests and 1 skipped test, but remained non-green because two
  out-of-scope environment-sensitive tests failed: Grok custom-asset discovery included live
  `~/.claude` plugins in an exact-array assertion, and the local install lacks
  `@xai-official/grok-darwin-arm64`. Neither failing module imports or exercises the renderer
  files in this review scope.

## Fixes landed

- Centralized renderer tool alias resolution in a non-recursive helper.
- Preserved existing `read_file`, `run_terminal_command`, `grep`, and `search_tool` compatibility.
- Added regression tests for both crash sites and all Grep name variants.

## Residual risk and boundaries

No unresolved in-scope finding remains. The full test command is not green in this checkout for the
two unrelated environment-sensitive failures recorded above; the scoped renderer tests, typecheck,
and production build are green.

## Follow-ups

No in-scope follow-up is required.

The non-hermetic Grok custom-assets test is tracked separately as Agent Deck issue
`456c44f3-a6a6-4985-a27d-53cec83fd465`.
