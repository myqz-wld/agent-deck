---
review_id: 265
reviewed_at: 2026-08-27
baseline_commit: 1c3f398469963cb96450e0f6f8b958337cf882c9
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review/changelog records and indexes are mechanical evidence added after implementation."
---

# REVIEW_265_system-status-session-readiness: Review status and startup consistency

## Scope and method

This review traced system-status production through Desktop worktree transitions, Server Core
recovery, and Claude/Codex/Grok command lifecycles. It then followed a newly created Claude session
from the trusted `session-start` through SessionManager persistence and the Renderer capability
readiness boundary. The file-level review-expiry script was run before finalizing this record.

```review-scope
README.md
src/core/system-status-copy.test.ts
src/core/system-status-copy.ts
src/hosts/server-core/mcp-worktree-coordinator.ts
src/hosts/server-core/mcp-worktree-recovery.ts
src/main/adapters/claude-code/__tests__/post-compact-hook.test.ts
src/main/adapters/claude-code/compact-message.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-compact-boundary.test.ts
src/main/adapters/claude-code/sdk-bridge/conversation-reset-core.test.ts
src/main/adapters/claude-code/sdk-bridge/conversation-reset-core.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/message-translation-state-core.test.ts
src/main/adapters/claude-code/sdk-bridge/message-translation-state-core.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize-core.test.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize-core.ts
src/main/adapters/codex-cli/sdk-bridge/session-command-controller.test.ts
src/main/adapters/codex-cli/sdk-bridge/session-command-controller.ts
src/main/adapters/grok-build/session-command-feedback.test.ts
src/main/adapters/grok-build/session-command-feedback.ts
src/main/adapters/grok-build/turn-response.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/__tests__/manager-test-setup.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager/_deps.ts
src/main/session/manager/session-registration.ts
src/main/session/worktree-transition/coordinator.ts
src/main/session/worktree-transition/recovery.ts
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/useAdapterRuntimeInfo.ts
src/renderer/components/activity-feed/records-view.test.tsx
src/renderer/components/activity-feed/rows/message-viewer.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Claude emitted its first visible SessionRecord before persisting permission, Gateway, model, thinking, and sandbox values. The detail page could therefore render empty/default controls and then replace them through later upserts. | Add a trusted, validated initial runtime projection to SDK `session-start` and write it into the first SessionRecord atomically; ignore the same payload on Hook events. |
| MEDIUM | Codex silent commands emitted only a system message, while Claude retained a terminal and Grok explicitly hid its terminal. Besides timeline inconsistency, a message without `finished` could leave session activity in a working state. | Emit Codex terminal outcomes, expose Grok terminals, preserve Claude's native terminal, and cover success/failure ordering. |
| LOW | Worktree and command system rows mixed warning icons, sentence-final punctuation, long prose, and adapter-specific completion grammar. | Introduce one host-neutral command formatter and align worktree status literals across Desktop and Server Core. |
| LOW | Renderer capability state could belong to the previously selected adapter for one render, and Claude controls appeared only after an asynchronous `listAdapters` result. | Identity-tag capability snapshots and gate Claude controls with the established 150 ms initial readiness policy. |

## Validation and evidence

- Focused regression suite passed: 12 files / 91 tests.
- `pnpm typecheck` passed architecture, Core Node, and both TypeScript configurations.
- `pnpm test` passed 1,017 files and 6,340 tests; 2 files and 3 opt-in tests were skipped.
- `pnpm build` completed Main, Preload, Renderer, and build-info output.
- `git diff --check` passed before record creation.
- Session-private Browser inspection found no open tab or local Renderer development server; no
  visual claim was made against the unchanged running Electron host.

## Residual risk

- Automated coverage proves the exact 150 ms state machine, atomic initial record, DOM projection,
  and complete provider event sequences. A manual post-restart observation remains the final proof
  that the packaged Electron host has no platform-specific paint artifact.
- Historical Grok terminal events already persisted with `suppressTimeline: true` remain hidden;
  newly generated events follow the corrected visible-terminal contract.

## Verdict

PASS. The reported copy inconsistency, silent-command terminal mismatch, and Claude startup flicker
have direct fixes and regression coverage, with no open CRITICAL, HIGH, MEDIUM, or LOW finding in
the reviewed scope.
