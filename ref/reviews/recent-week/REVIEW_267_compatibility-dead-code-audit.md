---
review_id: 267
reviewed_at: 2026-09-04
baseline_commit: 4a3db0094e195e4af92f0d87b138159318a1765f
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final changelog, review, plan, and rebucketed indexes are mechanical records added after implementation."
---

# REVIEW_267_compatibility-dead-code-audit: Compatibility and dead-code retirement

## Scope and method

Four concurrent read-only tracks audited MCP/image/protocol code, provider adapters and session
lifecycles, store/IPC/renderer surfaces, and core/host/dependency topology. Candidates were
deduplicated into retained compatibility, removable compatibility, confirmed dead code,
likely-dead code, and product-decision items. The user explicitly retired the external Image MCP
contract before implementation. A second production-entrypoint graph and repository-wide symbol
scan reviewed the integrated result. The file-level review-expiry report was run before this record
was finalized.

```review-scope
scripts/check-architecture-boundaries.mjs
src/hosts/server-core/mcp-browser-tools.ts
src/main/adapters/claude-code/adapter-init-host.ts
src/main/adapters/claude-code/gateway-fork-safety-host.ts
src/main/adapters/claude-code/gateway-profiles.ts
src/main/adapters/claude-code/hook-lifecycle-translate.ts
src/main/adapters/claude-code/sdk-bridge/can-use-tool-core.ts
src/main/adapters/claude-code/sdk-bridge/constants.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/message-file-changes-core.ts
src/main/adapters/claude-code/sdk-bridge/pending-cancellation.ts
src/main/adapters/claude-code/sdk-bridge/result-outcome.ts
src/main/adapters/claude-code/sdk-bridge/runtime-metadata-sync.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/translate.ts
src/main/adapters/codex-cli/adapter-init-host.ts
src/main/adapters/codex-cli/app-server/notification-helpers.ts
src/main/adapters/grok-build/adapter-host.ts
src/main/adapters/grok-build/custom-assets.ts
src/main/adapters/grok-build/resources.ts
src/main/adapters/runtime-profiles.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas.ts
src/main/agent-deck-mcp/transport-http-observability.ts
src/main/agent-deck-mcp/types.ts
src/main/browser-use/browser-presentation-controller.ts
src/main/browser-use/engine/cdp.ts
src/main/browser-use/engine/registry-core.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/engine/tab-collection-core.ts
src/main/browser-use/engine/tab.ts
src/main/browser-use/engine/types.ts
src/main/browser-use/screenshot-store.ts
src/main/browser-use/session-browser.ts
src/main/claude-config/plugin-assets.ts
src/main/codex-config/plugin-assets.ts
src/main/ipc/adapters-outgoing.ts
src/main/ipc/adapters.ts
src/main/ipc/assets.ts
src/main/ipc/browser.ts
src/main/ipc/images.ts
src/main/ipc/index.ts
src/main/ipc/remote-host.ts
src/main/ipc/settings.ts
src/main/ipc/window-app.ts
src/main/remote-host/input-validation.ts
src/main/session/manager/rename.ts
src/main/session/worktree-transition/resume-recovery.ts
src/main/store/event-repo.ts
src/main/user-assets.ts
src/main/window.ts
src/main/window/polish.ts
src/preload/api/adapters.ts
src/preload/api/browser.ts
src/preload/api/misc.ts
src/preload/api/remote-host.ts
src/protocol/messages.ts
src/protocol/relay/route-frame.ts
src/renderer/components/SessionCard.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/format.ts
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/activity-feed/rows/tool-end-row.tsx
src/renderer/components/activity-feed/tool-icons.ts
src/renderer/components/diff/renderers/ImageDiffRenderer.tsx
src/renderer/components/pending-rows/tool-input-diff.ts
src/renderer/hooks/useImageBlob.ts
src/shared/ipc-channels.ts
src/shared/remote-host/index.ts
src/shared/types.ts
src/shared/types/agent.ts
src/shared/types/assets.ts
src/shared/types/attachment.ts
src/shared/types/file.ts
```

Deleted production modules and their dedicated tests were reviewed as part of the diff but are not
listed in `review-scope`, because no current file remains for future expiry coverage.

## Findings and fixes landed

| Classification | Finding | Resolution |
|---|---|---|
| Removable compatibility | Arbitrary external MCP tools ending in `__ImageRead`, `__ImageWrite`, `__ImageEdit`, or `__ImageMultiEdit` still received privileged parsing, permission, file-change, whitelist, and UI handling even though the product no longer supports that protocol. | Removed the complete specialized chain while retaining uploads, generic image diffs, safe blob loading, and Remote image assets. |
| Removable compatibility | Local `browser_*` MCP registration was permanently false, and the official Codex native-pipe Browser backend had not been started since the unified CLI cutover. | Removed both retired fronts. Kept the current CLI/IAB path and Server Core's separately registered Remote fallback. |
| Removable compatibility | Claude hooks still accepted missing `tool_use_id` although the installed SDK requires it on the relevant lifecycle events. | Made the field required and removed the historical compatibility test. |
| Confirmed dead code | Permission scanners, multiple IPC/preload half-chains, user-asset enumeration, protocol wrappers, barrels, adapter facades, and test-only forwarding symbols had no production caller. | Removed each complete ownership chain or retargeted useful tests to the active Core/host implementation. |
| Integration gap found during cleanup | Architecture rules still named deleted facades, and an entrypoint graph exposed the retired native-pipe Browser group plus two barrels missed by the first audit. | Removed stale rules and modules; the final graph contains no non-fixture production orphan and no stale architecture path. |

No open CRITICAL, HIGH, MEDIUM, or LOW defect remains in the reviewed cleanup scope.

## Retained compatibility and runtime boundaries

- Claude, Codex, and Grok application/native session identity, resume, JSONL/history recovery,
  completion recovery, usage reconciliation, current wire extensions, and settings/environment
  lookup remain intact.
- Handoff aliases, `toolResponse`, old-settings-key isolation, database version guards, text
  `MultiEdit`, package peer/type dependencies, provider schema `v1` names, and packaged executable
  resolution remain intact.
- Server Core Remote Browser registration, Browser CLI/IAB, uploads, image file diffs, local safe
  image loading, and opaque Remote image assets remain intact.

## Validation and evidence

- Final production graph: 1,602 reachable modules from Electron main/preload/renderer plus all 11
  headless roots; every remaining unreachable file is an active test fixture/support module.
- Main/preload IPC symmetry: 148 ordinary methods and 57 Remote methods on each side, with empty
  set differences.
- All 34 package scripts resolve their referenced script files; architecture policy contains no
  nonexistent source path.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- The complete rerun passed 996 files and 6,216 tests, with 2 files and 3 opt-in live tests skipped.
  The sole first-run Remote Issues timing failure passed alone and in the complete rerun.
- Linux headless output built reproducibly for all roles. The amd64 and arm64 Feishu runtimes,
  Linux static/package checks, and deployment automation checks passed. An unrelated 500-line test
  guard was reduced to 499 lines without behavior change before the final checks.

## Residual risk

- The Codex JSON-RPC string-error branch and Grok uncompressed-binary fallback remain because
  current live/schema or release evidence is insufficient to prove removal safe.
- `FloatingWindow.flash` and the historical/future `swapLead` branch remain explicit product
  decisions, not static dead-code conclusions.
- Test fixtures in production directories remain active test assets and were not counted as
  deletable code.
- Static graph analysis cannot prove arbitrary computed imports, but package/build entrypoints,
  dynamic import sites, IPC/MCP registration, complete tests, Electron build, and every headless
  build root were checked independently.
- `scripts/check-architecture-boundaries.mjs` and the existing broad Composer SDK regression test
  remain over 500 lines. Only declarative removals and stale mocks were changed; splitting them now
  would broaden this deletion-focused change. Revisit when either gains a new responsibility family.
- No running or installed Agent Deck instance was restarted or replaced. Main/preload acceptance
  requires a separately approved development-instance restart.

## Verdict

PASS. High-confidence obsolete compatibility and dead code are removed, all current runtime and
security boundaries remain, and integrated Local/Remote/headless validation passes.
