---
review_id: 186
reviewed_at: 2026-07-27
baseline_commit: 9536d89f10f7e5a32aad1ca29c8e49bd643b55a5
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record and bucket-index maintenance are mechanical archive work."
---

# REVIEW_186_adapter-hook-contract-normalization: Cross-adapter hook contracts

## Scope and method

The review traced external CLI hook installation, HTTP routing, provider-payload translation,
persistence identity, and activity-feed rendering for Claude Code, Codex CLI, and Grok Build. A
separate `gpt-5.6-sol` reviewer at maximum reasoning audited the pinned provider versions and the
implementation independently. The fixes were then verified against translator fixtures, route and
installer contracts, renderer behavior, and the full Electron-ABI test suite.

```review-scope
src/main/adapters/claude-code/__tests__/hook-contract.test.ts
src/main/adapters/claude-code/__tests__/hook-translate.test.ts
src/main/adapters/claude-code/__tests__/translate-post-tool-use-toolcallid.test.ts
src/main/adapters/claude-code/hook-context.ts
src/main/adapters/claude-code/hook-installer.ts
src/main/adapters/claude-code/hook-lifecycle-translate.ts
src/main/adapters/claude-code/hook-routes.ts
src/main/adapters/claude-code/translate.ts
src/main/adapters/codex-cli/__tests__/hook-installer.test.ts
src/main/adapters/codex-cli/__tests__/hook-routes.test.ts
src/main/adapters/codex-cli/__tests__/hook-translate.test.ts
src/main/adapters/codex-cli/hook-installer.ts
src/main/adapters/codex-cli/hook-routes.ts
src/main/adapters/codex-cli/hook-translate.ts
src/main/adapters/grok-build/__tests__/hook-installer.test.ts
src/main/adapters/grok-build/__tests__/hook-routes.test.ts
src/main/adapters/grok-build/__tests__/hook-translate.test.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/adapters/grok-build/hook-installer.ts
src/main/adapters/grok-build/hook-translate.ts
src/main/adapters/grok-build/translate.ts
src/renderer/components/SessionDetail/__tests__/CliFooter.test.tsx
src/renderer/components/SessionDetail/CliFooter.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/activity-feed/rows/tool-row.test.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/tool-status.ts
src/renderer/components/settings/sections/__tests__/HookSection.test.tsx
src/renderer/components/settings/sections/HookSection.tsx
src/shared/types/session.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok Build's native harness wraps normal prompts in a canonical `<user_query>` envelope and forwards that wrapped value to `UserPromptSubmit`, so Agent Deck displayed provider protocol markup as user text. | Normalize only one exact, anchored LF/CRLF outer envelope at the Grok adapter boundary. Preserve the byte-equivalent raw prompt and normalization provenance; never recurse or strip malformed, prefixed, or sibling content. |
| HIGH | Claude `PreToolUse` and `PostToolUse` omitted `tool_use_id` from normalized tool events, while failure and denial terminal hooks were not installed or routed. Starts and ends therefore could not pair or deduplicate, and denied or failed tools could remain running forever. | Carry `toolUseId` through start and every terminal outcome; add `PostToolUseFailure` and `PermissionDenied`; preserve status, error/reason, duration, and interruption context. |
| HIGH | Claude installed `TaskCreated`, `TaskCompleted`, and `TeammateIdle` hooks even though the hook server intentionally had no routes for them. HTTP 404 responses were hidden by the fire-and-forget hook command. | Remove the three team events from the active install set, keep them in legacy cleanup, and make complete status require every active hook with no owned stale hook. Contract tests now assert that every active installed event has a route. |
| HIGH | External Claude and Codex sessions did not ingest submitted prompts, and all three adapters stored final assistant text only inside a `finished` payload that the renderer never displays. | Install and route `UserPromptSubmit` for Claude/Codex, add Codex `SessionEnd`, and emit normalized user/assistant message events before terminal events. |
| MEDIUM | Provider context was partially discarded: Grok used `modelId` while the adapter expected `model`, and tool duration, truncation, background, transcript, permission, prompt, and agent fields were inconsistently retained. | Expand adapter-boundary mappings for pinned provider fields and preserve common context on normalized events without teaching the renderer provider aliases. |
| MEDIUM | Any one installed hook caused all adapters to report a complete installation, hiding partial or stale configurations and removing the repair action. | Require all active hooks for complete status; the settings UI now distinguishes partial installation and exposes `修复 Hook`. |
| MEDIUM | A Grok ACP `tool_call` that arrived already completed or failed emitted only a start event because the translator expected a later update. | Emit start and terminal end atomically for initial terminal calls and clear the active-tool state. |
| MEDIUM | Ordinary notifications could put a session into waiting state, while denied, blocked, interrupted, cancelled, and error outcomes were collapsed into success-like tool rows with no duration or truncation context. | Only action-required notification types enter waiting. Centralize canonical tool status labels and render error/reason, duration, and provider truncation badges. |
| LOW | The external-terminal footer told every adapter user to run a `claude` command. | Render the actual Claude/Codex/Grok display name, with an adapter-neutral fallback. |

## Evidence and validation

- The pinned implementations were Claude Agent SDK `0.3.220`, Codex CLI `0.145.0`, and Grok
  Build `0.2.112`.
- xAI's Grok Build source constructs the canonical user-query envelope before hook dispatch:
  <https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/user_message.rs>.
- Codex hook coverage was checked against the exact `rust-v0.145.0` tag:
  <https://github.com/openai/codex/tree/rust-v0.145.0>.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.
- `pnpm typecheck` passed.
- The final Electron-ABI `pnpm test` run passed 400 files and 3,347 tests; one credentialed Codex
  live smoke remained skipped.
- `pnpm build`, `pnpm verify:bundled-runtimes`, and `git diff --check` passed.
- Changed production files remain below the repository's 500-line limit.

## Fixes landed

- Grok prompts now display without the harness-only envelope while retaining raw text for audit and
  the inherently ambiguous `--verbatim` edge case.
- Claude tool lifecycle events now pair and deduplicate across success, failure, interruption, and
  denial, with legacy no-route hooks removed during repair.
- Claude, Codex, and Grok external sessions retain user prompts and final assistant responses in the
  common message stream.
- Provider context, terminal statuses, error reasons, durations, and truncation signals survive into
  the activity feed.
- Partial hook installations are visible and repairable instead of being mislabeled as complete.

## Residual risk and boundaries

- Grok's hook payload exposes no `promptWasWrapped` or `verbatim` provenance bit. A user-authored
  canonical multi-line envelope in `--verbatim` mode is information-theoretically indistinguishable
  from the native wrapper. The fallback therefore keeps `rawText` and strips only one exact outer
  layer.
- This patch does not blindly install every provider-supported event. `MessageDisplay`,
  `PreCompact`, and subagent lifecycle events need a stable aggregation and deduplication contract
  before installation to avoid duplicate feed entries.
- A richer cross-adapter permission model and typed SessionStart metadata calibration remain broader
  architecture work; this patch preserves more hook context but does not redesign SDK/app-server
  permission flows.
- The currently running installed Agent Deck process owns the hook-server port and does not contain
  the rebuilt main-process code. Restarting it during this review would terminate the active
  session, so live three-CLI smoke validation was not performed here.

## Follow-ups

After restarting the rebuilt app, open Settings and use `修复 Hook` for any adapter shown as
incomplete. Then run one external CLI turn per adapter covering a successful tool, a failed or denied
tool, and final assistant text. For Grok, include a normal prompt and a nested literal
`<user_query>` prompt and confirm that only the harness outer layer is hidden.
