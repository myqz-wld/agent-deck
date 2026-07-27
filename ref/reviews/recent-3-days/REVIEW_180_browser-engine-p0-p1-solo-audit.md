---
review_id: 180
reviewed_at: 2026-07-27
baseline_commit: abc9f8180a9e1e4b828a06c7ae5fff99a6af47a2
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_180_browser-engine-p0-p1-solo-audit: Browser P0/P1 standalone Codex audit

## Scope and method

At the requester's direction, one standalone `reviewer-codex` session using `gpt-5.6-sol` with
`max` reasoning reviewed the complete browser engine, Codex front, MCP browser surface, lifecycle
ownership, packaged prompts, and tests. This was deliberately a single-reviewer audit, not a
`simple-review` or `deep-review` heterogeneous pair.

The first pass reported 12 findings: five HIGH, six MEDIUM, and one LOW. Repairs landed in
`506a20d9e480d92c305f95c24a5d11d6138e8427`; behavior records landed in `29d06fc2`. The same
reviewer then performed a bounded, read-only repair-verification pass over
`abc9f818..29d06fc2`, marked all 12 findings FIXED, found no repair-induced regression, and
returned `Coverage: COMPLETE`.

```review-scope
package.json
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
resources/grok-config/GROK_AGENTS.md
scripts/fixtures/browser-engine-electron.ts
scripts/verify-browser-engine-electron.mjs
src/main/adapters/runtime-profiles.ts
src/main/adapters/__tests__/runtime-profiles.test.ts
src/main/adapters/codex-cli/sdk-bridge/create-session-rollback.ts
src/main/agent-deck-mcp/types.ts
src/main/agent-deck-mcp/server.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/agent-deck-mcp/transport-stdio.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas.ts
src/main/agent-deck-mcp/tools/schemas/browser.ts
src/main/agent-deck-mcp/tools/browser-tools.ts
src/main/agent-deck-mcp/tools/handlers/browser/shared.ts
src/main/agent-deck-mcp/tools/handlers/browser/tabs.ts
src/main/agent-deck-mcp/tools/handlers/browser/interact.ts
src/main/agent-deck-mcp/tools/handlers/browser/inspect.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-finalization.ts
src/main/agent-deck-mcp/__tests__/browser-tools.test.ts
src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts
src/main/agent-deck-mcp/__tests__/transport-http-multi-client-init.test.ts
src/main/browser-use/protocol.ts
src/main/browser-use/server.ts
src/main/browser-use/session-browser.ts
src/main/browser-use/screenshot-store.ts
src/main/browser-use/fronts/codex-pipe.ts
src/main/browser-use/engine/types.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/engine/tab.ts
src/main/browser-use/engine/cdp.ts
src/main/browser-use/engine/actions.ts
src/main/browser-use/engine/scripts.ts
src/main/browser-use/engine/key-script.ts
src/main/browser-use/__tests__/protocol.test.ts
src/main/browser-use/__tests__/server.test.ts
src/main/browser-use/__tests__/codex-pipe.test.ts
src/main/browser-use/__tests__/screenshot-store.test.ts
src/main/browser-use/engine/__tests__/_fakes.ts
src/main/browser-use/engine/__tests__/registry.test.ts
src/main/browser-use/engine/__tests__/cdp.test.ts
src/main/browser-use/engine/__tests__/actions.test.ts
src/main/browser-use/engine/__tests__/scripts.test.ts
src/main/session/manager/lifecycle.ts
src/main/session/lifecycle-scheduler.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/__tests__/manager-delete.test.ts
src/main/session/__tests__/lifecycle-scheduler.test.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
ref/plans/recent-3-days/PLAN_19_cross-adapter-browser-engine.md
ref/changelogs/recent-3-days/CHANGELOG_401_browser-waits-open-dom-retention.md
```

## Findings and resolutions

| Severity | Finding | Resolution and verification |
|---|---|---|
| HIGH | Arbitrary remote pages inherited Electron's default-allow permission policy. | Install one deny-by-default request/check/device/display/HID/serial/USB policy per partition session before navigation. Unit tests assert once-per-partition registration; real Electron verifies notification and geolocation denial. |
| HIGH | Every page script received a synthetic user gesture. | Page probes now default to `userGesture: false`; only explicit click/type/background-key interactions opt in. Unit and real-Electron checks distinguish probe and click activation. |
| HIGH | A page could veto `BrowserWindow.close()` with `beforeunload` while MCP or Codex reported success. | Automation-owned tabs use `destroy()`. Fake and real hostile-`beforeunload` fixtures prove the window is destroyed, and both fronts converge on the same engine path. |
| HIGH | Mark-closed, scheduler close/purge, and direct delete could retain session-owned browser windows. | All terminal transitions now call the idempotent, non-creating, failure-isolated session browser disposer; focused lifecycle tests pin every added entry point. |
| HIGH | Hidden-window key aliases were accepted without reproducing native effects. | Normalize DOM and Electron keys separately and provide target-aware editing, caret/select, focus, activation/submission, scroll, textarea newline, and native-dialog Escape defaults. Generated scripts and real hidden windows cover the supported classes. |
| MEDIUM | A selector probe could overrun the public timeout indefinitely. | Main-process `Promise.race` bounds page evaluation and each probe receives only the remaining caller deadline. A blocked real renderer still returns the 100 ms timeout within the asserted wall-clock bound. |
| MEDIUM | A request failing after response headers stayed recorded as a successful response. | Defer success history until `loadingFinished`; `loadingFailed` finalizes with both received status and failure reason. A request → 200 → reset test pins the sequence. |
| MEDIUM | Optional snapshot text computed unbounded whole-document text outside the traversal cap. | Text nodes share the 20,000-DOM-node traversal budget and append only up to the requested limit; labels use a separate small per-element micro-bound. |
| MEDIUM | Full-page capture ignored `maxWidth` and allocated base64 even for path-only results. | CDP capture accounts for CSS size and display scale factor, enforces `maxWidth` plus a 16-million-physical-pixel ceiling, and checks PNG bytes before encoding. The real Retina fixture caught and verified the HiDPI correction. |
| MEDIUM | Public guidance claimed closed shadow roots were reported as inaccessible even though page APIs cannot observe them. | Runtime, tool descriptions, all three prompt assets, PLAN, and CHANGELOG now expose `closedShadowRoots: "not-observable"` and keep cross-origin frames in `inaccessibleFrames`. |
| MEDIUM | The critical Claude/Grok-enabled, Codex-disabled browser-surface invariant was not pinned end to end. | Tests pass each real adapter profile through tool registration and assert 14 tools for Claude/Grok and none for Codex. |
| LOW | Shared MCP annotations contradicted snapshot, screenshot, and page-interaction behavior. | Per-tool annotation families now distinguish local bookkeeping, open-world page reads, and non-read-only/non-idempotent page mutations; registration tests pin representative tools. |

## Preserved architecture invariants

- Codex remains official-Browser-plugin-only; `codex-cli.mcpBrowserTools` is still false.
- `src/main/browser-use/fronts/codex-pipe.ts` remains the only Codex protocol adapter.
- The load-bearing top-level event normalization remains exactly
  `const cdpSessionId = debuggerSessionId || undefined;`.
- Codex tabs do not arm MCP network capture or take ownership of official-client CDP domains.
- Browser state remains in `BrowserEngine` owner handles keyed by session/front, never on an MCP
  request or transport. HTTP remains stateless and per-request.
- Every browser tool remains denied to external callers.
- All changed production TypeScript files remain below 500 LOC; `tools/index.ts` remains 488 lines.

## Evidence and validation

- Initial reviewer pass: complete scope, 12 findings, no unreadable files.
- Repair-verification pass: all 12 findings FIXED, no new finding ids, `Coverage: COMPLETE`.
- Reviewer reran `pnpm typecheck`, 12 focused files / 108 tests,
  `pnpm test:browser-electron`, and `git diff --check abc9f818..HEAD`; all passed.
- Lead validation passed `pnpm typecheck`, the full Electron-ABI suite
  (379 files / 3,196 tests, one skipped), `pnpm test:browser-electron`, `pnpm build`,
  `pnpm logger:check`, and `git diff --check`.
- The real-Electron fixture verifies remote permission denial, probe/click activation boundaries,
  hidden-window key defaults, force-close, selector wall-clock timeout, and Retina-aware full-page
  width.
- The reviewer verified the worktree was clean before and after its read-only pass.

## Residual validation

No unresolved in-scope defect remains. Live Grok and Claude sessions, inline MCP image rendering,
and the packaged/overwrite-installed official Codex Browser regression remain release validation.
The Codex check is disruptive because it terminates the running Agent Deck and its app-server
children, so it still requires the requester's explicit approval.
