---
changelog_id: 398
changed_at: 2026-07-26
---

# CHANGELOG_398_session-owned-iab-dependency-refresh: Restore Browser visual QA

## Summary

Agent Deck Codex sessions now expose their own discoverable in-app Browser backend instead of
depending on an IAB owned by another Codex session. The Browser Plugin can bootstrap in the trusted
`node_repl`, discover the matching session backend, create isolated tabs, execute CDP commands, and
receive page events. Claude and Grok dependencies are also current, and the missing Grok
`darwin-arm64` platform package is installed again.

## Changes

### Trusted Browser bootstrap

- Add a narrowly matched `node_repl` preload that makes only the trusted frozen process facade's
  value slot writable while keeping it non-configurable.
- Inject that preload through the existing per-session sandbox-metadata proxy without exposing the
  host process or modifying the user-owned Browser Plugin cache.
- Preserve existing `NODE_OPTIONS`, target environment, and `ELECTRON_RUN_AS_NODE` behavior.

### Session-owned IAB backend

- Add the Browser Plugin's native-endian framed JSON-RPC transport over an Agent Deck-owned native
  pipe.
- Bind each connection to the first real Codex `session_id` and reject cross-session reuse.
- Advertise the required IAB build metadata so the official Browser client can discover the
  backend without spoofing another Codex session.
- Create each tab in a hashed, non-persistent Electron partition with sandboxing, context isolation,
  Node integration disabled, and web security enabled.
- Bridge tab, target, and CDP lifecycle operations, including top-level Electron debugger events
  that report an empty session id.
- Start the backend during infrastructure bootstrap and close its connections and owned windows
  before SQLite shutdown.

### Provider dependencies

- Update `@anthropic-ai/claude-agent-sdk` from `0.3.218` to `0.3.220`.
- Update `@anthropic-ai/sdk` from `0.114.0` to `0.115.0`.
- Update `@xai-official/grok` from `0.2.111` to `0.2.112`, including
  `@xai-official/grok-darwin-arm64@0.2.112`.
- Confirm `@openai/codex` remains current at `0.145.0`.

## Validation

- The exact installed Browser client imported in a freshly launched real ChatGPT `node_repl`;
  `setupBrowserRuntime({ globals: globalThis })` and the mandatory documentation call completed.
- The Browser client discovered the Agent Deck IAB, opened `http://127.0.0.1:3456/`, captured its
  DOM snapshot, and wrote a screenshot through the new native-pipe backend.
- `pnpm list` reports Claude Agent SDK `0.3.220`, Anthropic SDK `0.115.0`, Codex `0.145.0`, and Grok
  `0.2.112`.
- `pnpm why @xai-official/grok-darwin-arm64` resolves the installed `0.2.112` optional package.
- `pnpm install --frozen-lockfile --ignore-scripts` passed with pnpm `9.15.9`.
- `pnpm typecheck` passed.
- `pnpm test` passed 372 files and 3,112 tests; one file and one credentialed smoke remain skipped.
- `pnpm build` passed.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.

## Do Not Split Protection

The trusted bootstrap seam, session-matched backend, application lifecycle wiring, protocol tests,
and dependency lockfile form one Browser availability contract and must land together. Every
changed production TypeScript file remains below 500 lines.

## Notes

Already-running Agent Deck processes retain their old extracted `node_repl` and have no new native
pipe; install or launch the rebuilt application and start a fresh Codex session to use this fix.
The local Dev Config Hub renderer itself expects Electron IPC when opened as a plain HTTP page, so
its `ipcRenderer.invoke` error is separate from Browser transport and discovery. No UI, copy, or
documented setup changed, so README updates are unnecessary. The associated debug record is
`REVIEW_177_session-owned-iab-backend.md`.
