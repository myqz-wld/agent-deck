---
changelog_id: 401
changed_at: 2026-07-27
---

# CHANGELOG_401_provider-usage-runtime-control-fidelity: Preserve provider truth

## Summary

Token totals now contain only values returned by Claude Code, Codex CLI, or Grok Build. Missing
provider usage remains missing; the lightweight live token/s display may still estimate text
throughput, but those estimates never enter persisted usage.

Session runtime controls now follow adapter ownership across CLI, IPC, MCP spawn, hand-off, resume,
and UI surfaces. Claude Code exposes its complete permission-mode set, Codex surfaces native
app-server approval requests without forcing ordinary sessions to `approvalPolicy: "never"`, and
Grok Build keeps ACP-native modes and permissions. A control owned by another adapter is rejected
instead of being accepted and silently discarded.

## Changes

### Authoritative usage

- Remove Claude's approximate `system/thinking_tokens` persistence. Exact reasoning usage is
  recorded only when the provider result contains `output_tokens_details.thinking_tokens`, with
  assistant-frame values deducted to avoid duplicate rows.
- Treat Codex app-server `outputTokens` as already including reasoning tokens. Live token/s and
  persisted totals no longer add `reasoningOutputTokens` a second time.
- Preserve exact Codex `cacheWriteInputTokens` and Grok `cachedWriteTokens` as cache-creation
  usage instead of replacing them with zero.
- Add migration v048 to subtract reasoning from historical Codex output totals only for rows that
  contain the exact separately persisted reasoning value. Older rows that cannot be reconstructed
  exactly are intentionally left unchanged.
- Keep token/s display-only and simple: Codex uses provider ticks; Claude and Grok may use their
  existing transient text-throughput estimate.

### Provider-native permissions and sandboxes

- Add Claude Code SDK permission modes `dontAsk` and `auto` everywhere permission modes are
  validated, persisted, recovered, switched, and rendered.
- Stop forcing ordinary Codex sessions to `approvalPolicy: "never"`. Codex config/provider
  defaults remain authoritative; reviewer-codex retains an explicit non-interactive `never`
  exception.
- Implement app-server initiated approval transport for command execution, file changes, expanded
  permission grants, and legacy approvals. Pending rows use Codex's exact decision vocabulary and
  are aborted when app-server resolves, recycles, exits, or closes the request.
- Merge Codex `extraAllowWrite` with `additionalDirectories` into workspace-write
  `writableRoots`, preserving it through create, fork, resume, recovery, and hand-off.
- Keep Grok Build on ACP-native permission requests and `default` / `plan` / `ask` session modes;
  Claude or Codex controls are rejected.

### Adapter-owned public controls

- Add one adapter runtime-control contract used by CLI, IPC, MCP, hand-off, runtime profiles, and
  tests.
- Add strict per-adapter MCP schemas as the ownership source of truth. The current MCP tool
  transport still advertises a flat compatibility shape because its raw-shape serializer cannot
  represent a top-level discriminated union; field descriptions name the owner and runtime
  validation rejects every incompatible field.
- Reject foreign permission, session-mode, sandbox, provider, and writable-root controls instead
  of narrowing them away in CLI, IPC, MCP, or hand-off paths.
- Make the `resources/bin/agent-deck` launcher apply its default `bypassPermissions` only to
  Claude Code rather than leaking the flag into Codex or Grok payloads.
- Extract app-server request hosting, Codex permission hosting, and IPC runtime-control parsing so
  changed production facades remain within the 500-line guardrail.

## Validation

- Rebased without conflict onto `origin/main` at `abc9f818`.
- `pnpm typecheck` passed.
- `pnpm test` passed 383 files and 3,198 tests; one explicit live smoke test remained skipped.
  SQLite migration tests ran under Electron's ABI, including v048.
- `pnpm build` passed.
- `pnpm logger:check` and `git diff origin/main...HEAD --check` passed.
- `bash scripts/file-level-review-expiry.sh` ran before finalization.
- Installed Claude Code and Codex protocol typings were checked for the exact supported modes,
  request methods, permission profiles, and response vocabularies.

## Do Not Split Protection

- `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` remains 688 lines. It was
  already 700 lines and this delivery reduced it by removing approximate thinking-token state.
  It remains the established single SDK message dispatcher; the new authoritative reasoning
  accounting is already extracted. Revisit when another independent message family is added.
- Changed test files above 500 lines and SQL migrations are exempt under repository policy.

## Notes

- No live paid-provider session was run. Deterministic transport fixtures and installed protocol
  definitions cover the behavior, but a future manual smoke can confirm Pending-row interaction
  against each provider.
- Prompt-asset inventory and pre-edit backups are retained under the ignored
  `.prompt-asset-improver/local/` workspace. The manifest records original hashes and paths; restore
  by copying the corresponding manifest entry back to its `original_path`.
- The completed implementation plan is archived as
  `ref/plans/recent-3-days/PLAN_20_provider-usage-runtime-control-fidelity.md`.
