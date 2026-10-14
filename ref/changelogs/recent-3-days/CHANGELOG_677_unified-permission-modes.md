---
changelog_id: 677
changed_at: 2026-10-14
---

# Unified permission modes

## Summary

Claude, Codex, and Grok now offer the same two permission choices: automatic approval and no
routine approval prompts. Work-mode, planning, and edit-only choices are removed from session
creation, live controls, handoff, and remote/Feishu preference controls. Sandbox selection stays
independent. `acceptEdits` is excluded because Codex has no corresponding native preset.

## Changes

- Shared permission presets map to Claude `auto` / `bypassPermissions`, Codex `on-request` with
  `approvalsReviewer: auto_review` / `never`, and Grok's mutually exclusive `autoMode` / `yoloMode`.
  Native mandatory restrictions and auto-mode availability remain provider-owned.
- The existing permission column persists the common selection without a schema migration.
  Codex creation, resume, fork, JSONL fallback, and subsequent turns carry the selection. Legacy
  contradictory Claude metadata cannot override a Codex session's persisted native policy.
- Codex switches serialize with recovery and preserve its lock ownership. Failed publication
  restores the exact live snapshot and attempts every durable rollback step. Legacy raw policy
  mutation is rejected once a shared preset owns the session, avoiding a silently shadowed write.
- Grok creation/load metadata carries both native flags. Live switching sends the native ACP
  permission notification and resets legacy planning/ask work mode through acknowledged
  `session/set_mode`. Unknown native outcomes dispose the runtime; failed persistence restores
  the previous durable settings before recovery. Each session retains its own ACP child.
- Local/Core capabilities, IPC, CLI permission input, MCP creation/handoff, and Feishu preferences
  accept the common presets. Legacy raw provider settings remain compatibility seams. Existing
  live sessions retain their actual native state until a new choice is applied; the UI shows a
  legacy-state label instead of claiming automatic approval.
- README and the three permission-related MCP schema/description assets document the new
  behavior. Paired runtime Markdown was checked without changing its workflow instructions.

## Validation

- `pnpm typecheck` passed, including architecture and Core Node-boundary checks.
- Full `pnpm test` passed: 7,188 tests passed, 6 skipped, across 1,149 passing files and 3 skipped files.
- `pnpm build` passed. No packaging, installation, or application restart was performed.
- Validation used a source snapshot containing 117 delivery files over baseline
  `aeb0a90f99e8ceba9e3dacad5f0bca7e644137ee`. File hashes still match the shared checkout.
  The snapshot excludes concurrent Claude-input and runtime-logging changes and shares the existing
  dependency installation. The Electron test runner did not rebuild native bindings.
- Scoped prompt inventory hashes, local Markdown links, added-line privacy, and `git diff --check`
  passed. All changelog and plan buckets were rescanned; no existing records required moving.

The final targeted workspace run passed 73 tests across nine files. Full shared-workspace testing
reached 7,211 passed and 6 skipped with one failure in the concurrently added
`src/hosts/relay/diagnostic-router.test.ts`; the same file also introduced an unrelated type error.
An earlier transient `RemoteIssuesPanel` test failure passed on its bounded rerun. No changes were
made to these concurrent features for this delivery.

## Do Not Split Protection

- `src/main/adapters/codex-cli/app-server/thread.ts` remains 507 lines after moving the permission
  option transformation into `thread-mode.ts`. The remaining long turn method owns acceptance,
  cancellation, notification buffering, and generation cleanup together. Further facade/state
  extraction needs a lifecycle-focused plan or review; revisit with the next turn-owner change.
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` retains its existing shared hoisted mocks and
  fixture graph. This task only changes two permission expectations there; new native/controller
  regressions use separate small test modules. Revisit during a shared MCP test-harness refactor.
  Handoff fixture data was extracted so its changed test module is under 500 lines.

## Activation and evidence

No application, installed bundle, or live provider process was stopped, restarted, or replaced.
The installed application needs an updated package and a separately authorized restart to use
these source changes. The user subsequently authorized committing this delivery and an IAB interaction demonstration.
No application replacement, restart, or publication was requested.

Grok's built-in `read-only` profile protects project files while keeping its state and temporary
directories writable. This delivery does not change sandbox behavior. See the official
[Grok sandbox documentation](https://docs.x.ai/build/features/sandbox),
[Grok permission documentation](https://docs.x.ai/build/features/permissions), and native
[Grok permission mapping](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/auto_mode.rs).
Codex mapping was checked against the bundled 0.162.1 app-server schema and
[automatic review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review).
The ACP underscore prefix follows the official
[extension protocol](https://agentclientprotocol.com/protocol/v1/extensibility).

Completed plan: `ref/plans/recent-3-days/PLAN_88_unified-permission-modes.md`.
