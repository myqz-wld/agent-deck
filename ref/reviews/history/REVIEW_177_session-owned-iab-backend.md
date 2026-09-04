---
review_id: 177
reviewed_at: 2026-07-26
baseline_commit: 2efdb6d35243984707f90f19325fb8d5872d075d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_177_session-owned-iab-backend: Session-owned Browser backend audit

## Scope and method

Continued the real-runtime investigation recorded in
`REVIEW_175_node-repl-browser-process-bootstrap.md`, inspected the official Browser client's
discovery and CDP contracts, and exercised the implementation end to end through the installed
Browser bundle and a real ChatGPT `node_repl`.

```review-scope
package.json
pnpm-lock.yaml
resources/bin/node-repl-browser-process-compat.cjs
resources/bin/node-repl-sandbox-meta-proxy.cjs
src/main/adapters/codex-cli/app-server/node-repl-compat.test.ts
src/main/browser-use/protocol.ts
src/main/browser-use/server.ts
src/main/browser-use/iab-session.ts
src/main/browser-use/__tests__/protocol.test.ts
src/main/browser-use/__tests__/server.test.ts
src/main/browser-use/__tests__/iab-session.test.ts
src/main/index/_deps.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/index/__tests__/_deps.test.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/__tests__/checkpoint-shutdown-entry.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The official Browser client accepts only an IAB whose `metadata.codexSessionId` equals the calling session id. Reusing another Codex session's IAB would require identity spoofing, while Agent Deck exposed no matching backend after bootstrap. | Added an Agent Deck-owned native-pipe backend. Every connection binds to its first real `session_id`, rejects switching, and owns isolated Electron tabs for that connection. |
| MEDIUM | Session identity alone was insufficient for discovery because the Browser client also filters IAB candidates by Codex application build flavor. | Return the required `codexAppBuildFlavor` metadata, defaulting to the production flavor while allowing an explicit runtime override. |
| MEDIUM | Electron reports top-level debugger events with an empty-string session id. Forwarding that value made the Browser client treat page events as child-target traffic and drop `Fetch.requestPaused`, deadlocking navigation. | Normalize an empty debugger session id to an absent top-level session before constructing the event source; regression coverage asserts the exact event shape. |
| MEDIUM | The local Grok resolver test could not find `@xai-official/grok-darwin-arm64`, and the Claude/Grok runtime packages had newer stable releases. | Refresh Claude and Grok packages and their platform lock entries, retain current Codex `0.145.0`, and verify the actual installed Grok platform dependency. |

## Evidence and validation

- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- The real ChatGPT `node_repl` imported the unmodified installed Browser client, completed
  `setupBrowserRuntime({ globals: globalThis })`, and returned the mandatory Browser documentation.
- The same client discovered the session-owned IAB, listed tabs, created a tab, navigated to
  `http://127.0.0.1:3456/`, captured a DOM snapshot, and produced a screenshot.
- The end-to-end run reproduced and then cleared both discovery-filter and empty-session-id
  failures; the final navigation completed through the official client.
- Protocol tests cover split/coalesced frames, native-endian length encoding, input validation, and
  frame limits.
- Server tests cover requests, notifications, handler errors, connection disposal, live-pipe
  refusal, and shutdown cleanup.
- IAB tests cover session binding, required metadata, isolated window options, CDP commands,
  top-level events, child targets, and owned-window disposal.
- `pnpm why @xai-official/grok-darwin-arm64` resolves version `0.2.112`, and the focused Grok binary
  resolver test passes.
- `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm typecheck`, `pnpm build`, and
  `git diff --check` passed.
- The full suite passed 372 files and 3,112 tests, with one file and one credentialed smoke skipped.

## Fixes landed

- Kept the exact trusted-process bootstrap compatibility fix from `REVIEW_175`.
- Added a framed native-pipe Browser broker with per-connection Codex session ownership.
- Added sandboxed, non-persistent Electron tabs and the Browser client's required CDP surface.
- Wired best-effort startup and orderly shutdown into the application lifecycle.
- Updated Claude and Grok dependencies and restored Grok's Darwin ARM64 optional package.

## Residual risk and boundaries

- A running installed Agent Deck application cannot hot-load this main-process backend or retrofit
  its already-started `node_repl`; the rebuilt application and a fresh session are required.
- The backend intentionally does not reuse another Codex session's IAB, cookies, tabs, or
  authentication state.
- The Dev Config Hub renderer at port 3456 loads in the Browser, but when treated as an ordinary web
  page it reports that `ipcRenderer.invoke` is unavailable because its application data path
  requires Agent Deck's privileged Electron preload. That target-specific limitation is outside
  Browser bootstrap, discovery, transport, and CDP ownership.
- The strict process-facade matcher and Browser protocol metadata are coupled to the currently
  installed trusted runtimes; their tests should be updated if those upstream contracts change.

## Follow-ups

No unresolved in-scope Browser backend or provider-dependency defect remains. The associated
behavior record is `CHANGELOG_398_session-owned-iab-dependency-refresh.md`.
