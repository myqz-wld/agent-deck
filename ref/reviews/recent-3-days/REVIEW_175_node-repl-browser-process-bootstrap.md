---
review_id: 175
reviewed_at: 2026-07-26
baseline_commit: 2efdb6d35243984707f90f19325fb8d5872d075d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_175_node-repl-browser-process-bootstrap: Browser process bootstrap compatibility

## Scope and method

This debug review reproduced the reported Browser Plugin import in the real ChatGPT `node_repl`,
captured the failing stack, inspected the extracted runtime kernel, and compared the trusted
process contract with both the installed and application-bundled Browser clients. It then exercised
the compatibility path in an isolated VM fixture and through the real `node_repl` binary.

```review-scope
resources/bin/node-repl-browser-process-compat.cjs
resources/bin/node-repl-sandbox-meta-proxy.cjs
src/main/adapters/codex-cli/app-server/node-repl-compat.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Current ChatGPT `node_repl` builds install a non-writable, non-configurable metadata-only `process` facade in the trusted module realm. Both Browser clients trusted by that runtime unconditionally execute `globalThis.process = processShim`, so importing `browser-client.mjs` fails before setup or discovery. | Added an Agent Deck-owned preload at the existing `node_repl` proxy boundary. It recognizes only the exact frozen safe-process facade on a VM context and changes only its value slot to writable while keeping it non-configurable. |
| MEDIUM | A broad process override or Plugin-cache patch would either weaken the runtime boundary or mutate user-owned native Plugin assets. | The preload restores the host `Object.defineProperty` intrinsic immediately after the one exact match (or on the next event-loop turn), never exposes the host process, and leaves unrelated locked properties unchanged. The Browser Plugin cache remains untouched. |

## Validation evidence

- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- The original MCP bootstrap reproduced `TypeError: Cannot redefine property: process` at
  `browser-client.mjs:33`; the model-code realm itself had no exposed `process`.
- The extracted kernel confirmed that trusted Browser code receives a frozen facade with only
  `arch`, `cwd`, `env`, `off`, `once`, `pid`, and `platform`.
- Through the source proxy and the real
  `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl`, the exact installed Browser
  client imported successfully and exported `setupBrowserRuntime`.
- The real runtime completed `setupBrowserRuntime({ globals: globalThis })` and proceeded to Browser
  discovery. The compatibility smoke then returned `agent.browsers.list() === []`, rather than the
  original import exception.
- The focused compatibility suite passed 8 tests, including exact facade replacement, unrelated
  descriptor preservation, environment preservation, legacy metadata retry, and modern passthrough.
- `pnpm typecheck` and `pnpm build` passed.
- `pnpm test` passed 365 files and 3,096 tests, with one explicit live smoke skipped. Its only failure
  was the unrelated existing Grok binary-resolution test because
  `@xai-official/grok-darwin-arm64` is not installed in the concurrent worktree.
- `git diff --check` passed.
- `http://127.0.0.1:3456/` continued to return HTTP 200 during the Browser runtime smoke.

## Fixes landed

- Added a self-contained pre-kernel compatibility preload under `resources/bin`.
- Extended the existing per-session `node_repl` proxy to append the preload through `NODE_OPTIONS`
  while preserving target environment and `ELECTRON_RUN_AS_NODE` behavior.
- Added regression coverage for the preload seam and its narrow descriptor match.

## Residual risk and boundaries

- Existing Agent Deck sessions retain their already-started `node_repl` process. A rebuilt
  application and a fresh session are required to exercise the packaged fix.
- The official in-app Browser backend is session-owned. The Browser client filters IAB candidates
  to `metadata.codexSessionId === x-codex-turn-metadata.session_id`; an Agent Deck SDK session cannot
  safely reuse another Codex session's IAB by spoofing that identity. The current smoke found no
  session-matched Browser backend, so this fix restores bootstrap and discovery but does not create
  an IAB surface for Agent Deck.
- The preload seam depends on the current `node_repl` child honoring `NODE_OPTIONS`, which the real
  binary smoke verified. Its exact facade check intentionally becomes a no-op if the upstream
  process contract changes again.

## Follow-ups

An Agent Deck-owned visual-QA surface would require a supported, session-owned Browser backend or a
native browser surface. It should be designed separately rather than bypassing the Browser Plugin's
IAB session-isolation check. Follow-up issue:
`70dead46-e923-47ed-83f3-50c0f221f6da`.
