---
changelog_id: 638
changed_at: 2026-09-04
---

# CHANGELOG_638_compatibility-dead-code-retirement: Retire obsolete compatibility and dead code

## Summary

Removed obsolete compatibility surfaces and production-dead modules identified by a four-track
repository audit. The cleanup removes more than 8,300 net lines while preserving current provider
recovery, security, Browser CLI, Remote Browser, uploaded-image, image-diff, and Remote image-asset
behavior.

## Changes

### Compatibility cutovers

- Removed special recognition, result parsing, automatic permission, file-change projection, and
  renderer presentation for external `ImageRead`, `ImageWrite`, `ImageEdit`, and `ImageMultiEdit`
  MCP tools. User-uploaded images and generic Local/Remote image diffs remain supported.
- Removed the permanently disabled Local `browser_*` MCP tool factory, handlers, schemas, runtime
  profile flag, observability classifications, and tests. Server Core's Remote `browser_*` fallback
  remains registered and now imports shared operation schemas directly.
- Removed the retired official Codex Browser native-pipe server/front and its connection lease and
  CDP child-target compatibility. Current sessions continue through the authenticated,
  session-scoped `agent-deck-browser` CLI broker.
- Made Claude lifecycle-hook `tool_use_id` handling match the current required SDK contract and
  removed the old missing-id compatibility case.

### Dead surfaces and facades

- Removed the unused permission-scanner feature and orphaned IPC endpoints for direct steering,
  queued-attachment loading, Browser tab selection, user-asset listing, window actions, Remote
  project/history listing, and Remote NodeHook install/uninstall.
- Removed obsolete user/plugin asset snapshot enumeration while retaining by-name provider-native
  Agent resolution, content reads, reveal paths, and path validation.
- Removed unused Relay/client wrappers, protocol decoder/type aliases, host/core barrels, renderer
  wrappers, and 32 production-unreachable adapter facades. Tests now compose the active Core and
  host boundaries directly where integration coverage is still useful.
- Removed stale architecture-boundary entries for deleted modules. Electron main/preload IPC sets
  remain exactly symmetric, and the production entrypoint graph now contains no non-fixture orphan
  module.

## Validation

- `pnpm typecheck` passed architecture checks and both TypeScript configurations.
- `pnpm test` passed 996 files and 6,216 tests; 2 files and 3 opt-in live tests were skipped. One
  unrelated Remote Issues timing test failed on the first concurrent run, passed in isolation, and
  passed in the complete rerun.
- `pnpm build` passed main, preload, renderer, and build-info generation.
- `pnpm logger:check` passed with no direct console calls.
- All 11 Linux headless roles built reproducibly; fixed amd64/arm64 Feishu runtimes built and
  verified; `pnpm check:linux-headless` and `pnpm check:deployment` passed.
- Repository-wide retired-symbol, production-reachability, IPC-symmetry, package-script, stale
  architecture-path, and `git diff --check` scans passed.

## Do Not Split Protection

- `scripts/check-architecture-boundaries.mjs` remains above 500 lines because it is the existing
  declarative repository-wide policy table; this change only removes stale entries. Revisit when a
  new rule family requires extracting table construction behind the same command.
- `src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx` remains above 500 lines.
  This change only removes mocks and assertions for deleted IPC methods; splitting the broad
  composer regression suite is separate structural work. Revisit when adding another composer
  behavior family.

## Notes

No active README described the retired surfaces, so no README change was required. The cleanup
intentionally retains the Codex JSON-RPC string-error branch, Grok bare-binary fallback,
`FloatingWindow.flash`, `swapLead` historical branch, and active test fixtures pending their
separate evidence or product decisions. Main and preload changed, so a running development instance
requires an explicitly approved restart before it can use this source state.

## Related records

- `ref/reviews/recent-3-days/REVIEW_267_compatibility-dead-code-audit.md`
- `ref/plans/recent-3-days/PLAN_46_compatibility-dead-code-cleanup.md`
