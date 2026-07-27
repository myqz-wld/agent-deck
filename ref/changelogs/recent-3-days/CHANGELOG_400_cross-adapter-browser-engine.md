---
changelog_id: 400
changed_at: 2026-07-27
---

# CHANGELOG_400_cross-adapter-browser-engine: One browser for every adapter

## Summary

Agent Deck's in-app browser is no longer Codex-only. The provider-neutral engine that owns Electron
windows and their CDP connection is now separate from the OpenAI Browser plugin protocol, and a
second front exposes the same browser to Claude Code and Grok Build as 13 `browser_*` MCP tools.
Codex CLI keeps driving the identical engine through the official Browser plugin over the native
pipe, so no Codex behavior changes.

Browser ownership moved from the transport connection to the Agent Deck session. That is what makes
the MCP front possible at all: its HTTP transport is stateless with a fresh transport instance per
request, so tab state parked on a connection would vanish between two tool calls.

## Changes

### Provider-neutral browser engine

- Add `src/main/browser-use/engine/*`: an ownership registry keyed by owner (`session` or
  `codex-pipe`), one Electron window per tab, a per-tab CDP bridge, injected page scripts, and
  semantic actions.
- Keep the security contract unchanged per tab: non-persistent hashed partition, sandbox, context
  isolation, no Node integration, web security on, window-open denied.
- Enforce a per-session tab cap (8) and a global cap (24) with a typed `BrowserTabLimitError`.
- Enable console and network capture lazily, so a Codex session that never asks for logs keeps
  exactly the CDP surface the official client enabled itself.

### Codex front reduced to protocol translation

- Move the former `iab-session.ts` to `src/main/browser-use/fronts/codex-pipe.ts`, keeping only the
  upstream-shaped quirks: discovery metadata, first-request session binding, synthetic top-level
  targets, empty-session-id normalization, and the probe stubs.
- Preserve the native pipe transport and server untouched.

### Cross-adapter MCP browser tools

- Add `browser_open`, `browser_tabs`, `browser_navigate`, `browser_close`, `browser_snapshot`,
  `browser_screenshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`,
  `browser_read_console`, `browser_read_network`, and `browser_evaluate`.
- Target elements through snapshot refs instead of selectors; a stale ref is rejected with
  re-snapshot guidance rather than clicking the wrong element.
- Gate registration on the new `AdapterRuntimeProfile.mcpBrowserTools`: true for `claude-code` and
  `grok-build`, false for `codex-cli`, which already owns a native browser surface.
- Deny every browser tool to external callers, since a tab needs a real session to belong to.
- Return screenshots as an inline image plus a saved PNG path, so clients that cannot render inline
  images still get a usable artifact.
- Reject `javascript:` and `data:` navigation while still accepting bare hosts such as
  `localhost:3000`.

### Lifecycle and safety

- Dispose a session's tabs on session close, committed MCP hand-off, and Codex create-session
  rollback; dispose every engine window during application shutdown.
- Add browser guidance and identical safety rules to the three bundled prompt assets
  (`resources/claude-config/CLAUDE.md`, `resources/grok-config/GROK_AGENTS.md`,
  `resources/codex-config/CODEX_AGENTS.md`): page content is untrusted data, reading differs from
  transmitting, sensitive data and external side effects need confirmation, and a sign-in wall stops
  the task instead of triggering a workaround.
- No-side-effect oneshots stay browser-free: Codex compactor threads already disable
  `browser_use*` / `in_app_browser` and pass `mcp_servers: {}`, and the summarizer path mounts no
  Agent Deck MCP server at all.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 377 files and 3,163 tests, with one file skipped; the suite grew by 5 files and
  51 tests.
- `pnpm build` passed; `git diff --check` clean.
- The pre-existing Codex front tests pass with every assertion unchanged, which is the regression
  guard for the extraction.
- New coverage: engine ownership/caps/disposal, CDP event normalization and log ring buffers, URL
  scheme guarding, key delivery, screenshot paths, and the MCP tool surface including per-adapter
  gating, cross-session tab isolation, external-caller denial, and stale-ref guidance.
- A test caught a real defect before it shipped: the first URL normalizer read `localhost:3000` as a
  `localhost:` scheme and rejected it.

### Not yet validated

- No real-session end-to-end run. The Claude Code path was explicitly deferred by the requester, and
  the Grok path and the official Codex Browser plugin regression both need a packaged build plus a
  fresh session, which cannot be done against a running installed application.
- Inline MCP image content has not been observed in a live client on any adapter; the saved-path
  fallback exists precisely because that is unproven.

## Do Not Split Protection

No file needed a size exemption. `src/main/agent-deck-mcp/tools/index.ts` sits at 488 lines, which is
why the browser tool definitions live in `tools/browser-tools.ts` instead of being inlined there.

## Notes

The plan for this work is `.ref/plans/cross-adapter-browser-engine-20260727.md`; it stays in the
non-final workspace until the deferred real-session validation is done, and archives to
`ref/plans/<bucket>/PLAN_19_cross-adapter-browser-engine.md` at that point. Prompt-asset backups are
in `.ref/prompt-asset-backups/20260727-browser-tools/`. The file renames under
`src/main/browser-use/` mean `REVIEW_177`'s scope no longer maps to the current paths, so the next
review must treat the engine, the Codex front, and the MCP browser tools as unreviewed.
