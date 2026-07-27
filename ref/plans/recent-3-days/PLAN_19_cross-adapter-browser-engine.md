---
plan_id: PLAN_19
title: Cross-adapter browser engine and MCP browser tools
status: implemented-pending-real-session-validation
created_at: 2026-07-27
updated_at: 2026-07-27
completed_at: 2026-07-27
base_branch: main
base_commit: 753bff9a15f11bbeaf2c4d7c6359fe06465ee9e0
implementation_commit: 98471b111f99515827cb90d8384fab814994bf4f
related_changelog: CHANGELOG_400
related_reviews: REVIEW_175, REVIEW_177
---

# PLAN_19_cross-adapter-browser-engine: One browser for every adapter

## Goal and invariants

- Make Agent Deck's own browser reachable from every adapter, present and future, instead of only
  from Codex sessions that load the OpenAI Browser plugin.
- The Codex Browser plugin path keeps working at the protocol level; its tests pass with unchanged
  assertions.
- Browser ownership is per Agent Deck session id, never per transport connection and never global.
- Tab isolation stays intact: non-persistent hashed partition, `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, window-open denied.
- No browser capability leaks into no-side-effect oneshots (checkpoint, periodic summary,
  Continuation Context).
- Page content is untrusted input, labelled as such in tool results and in all three bundled prompt
  assets.
- Every changed production TypeScript file stays under 500 LOC.

## What landed

| Area | Files | Note |
|---|---|---|
| Engine | `src/main/browser-use/engine/{types,registry,tab,cdp,actions,scripts}.ts` | 1,179 LOC, provider-neutral |
| Codex front | `src/main/browser-use/fronts/codex-pipe.ts` | 407 LOC, replaces the deleted 497-LOC `iab-session.ts` |
| Session helper | `src/main/browser-use/session-browser.ts` | owner key + idempotent disposal |
| MCP tools | `agent-deck-mcp/tools/browser-tools.ts`, `tools/schemas/browser.ts`, `tools/handlers/browser/{shared,tabs,interact,inspect}.ts` | 13 tools |
| Wiring | `runtime-profiles.ts`, `agent-deck-mcp/types.ts`, `tools/index.ts`, `tools/schemas.ts` | names, allow-list, per-adapter gating |
| Lifecycle | `session/manager/lifecycle.ts`, `hand-off-session/source-finalization.ts`, `codex-cli/sdk-bridge/create-session-rollback.ts`, `index/lifecycle-hooks.ts` | disposal on close, hand-off, rollback, quit |
| Prompt assets | `resources/{claude-config/CLAUDE.md,grok-config/GROK_AGENTS.md,codex-config/CODEX_AGENTS.md}` | 14 added lines each, identical safety rules |
| Tests | `browser-use/engine/__tests__/{_fakes,registry,cdp,actions}`, `agent-deck-mcp/__tests__/browser-tools.test.ts` | 725 LOC, +51 tests |

Tool surface: `browser_open`, `browser_tabs`, `browser_navigate`, `browser_close`,
`browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press`,
`browser_scroll`, `browser_read_console`, `browser_read_network`, `browser_evaluate`. Enabled for
`claude-code` and `grok-build` through `AdapterRuntimeProfile.mcpBrowserTools`; `codex-cli` is false
because it already owns the plugin surface.

## Decisions taken

1. Screenshots return an inline MCP image block plus a saved PNG path. The live spike was skipped, so
   the path is the fallback rather than a proven need.
2. `browser_cdp` was not shipped. Front A keeps unrestricted raw CDP; an MCP-side raw escape hatch
   needs the settings toggle that does not exist yet.
3. Gating is a profile flag, not a narrowed `mcpTools` policy and not a user setting.
4. Codex CLI gets no MCP browser tools at all, rather than runtime-detecting whether the Browser
   plugin is active for that session.
5. `browser_evaluate` shipped.
6. The attached in-app view stayed out of scope.

## Remaining validation

Nothing in this list is done. Each item needs a human decision because of what it disturbs.

1. **Grok Build end-to-end**: main-process code changed, so `pnpm dev` must be restarted
   (see the restart block in `CLAUDE.md`). Cover open, navigate, snapshot, click, screenshot, and
   console read against a local page.
2. **Claude Code end-to-end**: explicitly deferred by the requester; same checklist as Grok.
3. **Official Codex Browser plugin regression**: needs `pnpm dist`, an overwrite install, ad-hoc
   re-sign, and a fresh session. This kills the running installed Agent Deck, including its
   `node-repl-sandbox-meta-proxy` child and Codex app-server processes. Ask before doing it, and
   follow the packaging sequence in `CLAUDE.md` exactly.
4. **Inline MCP image rendering**: unverified in any live client. If a client rejects images, keep the
   text block and drop the image block rather than failing the tool.

## Traps for the next session

- **Keep upstream quirks in front A.** `codex-pipe.ts` is the only file allowed to know about
  `type: 'iab'`, `codexSessionId`, `codexAppBuildFlavor`, synthetic `agent-deck-iab-tab:<id>`
  targets, and the empty-session-id normalization. That normalization is load-bearing: forwarding
  Electron's empty string makes the official client treat page traffic as child-target traffic, drop
  `Fetch.requestPaused`, and deadlock navigation (REVIEW_177).
- **Never park browser state on a transport or a request.** The MCP HTTP transport is stateless with a
  fresh transport instance per request. All state belongs in the engine registry keyed by session id.
- **Adding a browser tool takes four edits**: `AGENT_DECK_TOOL_NAMES`, `EXTERNAL_CALLER_ALLOWED`
  (default false), a schema in `tools/schemas/browser.ts`, and a handler plus registration in
  `tools/browser-tools.ts`. Do not inline new tool definitions into `tools/index.ts`: it is at 488 of
  500 lines.
- **The window doubles implement only what the engine touches.** Reaching for a new Electron API means
  updating `engine/__tests__/_fakes.ts`, and the engine deliberately guards `executeJavaScript`,
  `capturePage`, `sendInputEvent`, and `isLoading` with capability checks so a double without them
  fails loudly instead of silently.
- **Engine singleton**: production uses `getBrowserEngine()`; tests inject through
  `setBrowserEngine(new BrowserEngine({ createWindow }))` and must reset with `setBrowserEngine(null)`.
  A front that receives an injected `createWindow` builds its own private engine, which is how the
  Codex front tests stay isolated from global caps.
- **CDP domains are enabled lazily on purpose.** A Codex session that never reads logs keeps exactly
  the CDP surface the official client enabled itself. Do not move `Runtime.enable` / `Network.enable`
  into attach.
- **Prompt assets are edited in triples.** `resources/claude-config/CLAUDE.md`,
  `resources/grok-config/GROK_AGENTS.md`, and `resources/codex-config/CODEX_AGENTS.md` must keep
  identical safety semantics; wording may differ only on adapter-surface facts. Do not leave `.bak`
  files inside `resources/`: that directory is packaged into the app bundle.
- **Review scope**: the renames under `src/main/browser-use/` mean `REVIEW_177` no longer maps to
  current paths. The engine, the Codex front, and the MCP browser tools must be treated as unreviewed
  by the next review.

## Known functional gaps

These are real limitations of the shipped surface, not bugs to file blindly. Pick them up only when a
concrete use case appears.

- **No iframe or shadow-DOM traversal.** `browser_snapshot` walks the top document with
  `querySelectorAll`, so elements inside iframes or shadow roots have no refs. Front A can still reach
  child targets through raw CDP; the MCP surface cannot. Fixing this means per-frame snapshot state
  and a frame-qualified ref format.
- **Ref state lives in the page.** Refs are stored on `window.__agentDeckBrowserRefs__`, so any
  navigation or reload wipes them and the next click reports a stale ref. That is intended, but it
  means "click, then click again after navigation" always needs a re-snapshot.
- **No wait primitives.** `waitForSettle` polls `webContents.isLoading()`, which says nothing about
  SPA route transitions or async data. There is no wait-for-selector or network-idle tool, so agents
  must re-snapshot in a loop for slow UIs.
- **Log capture is not retroactive.** Console and network buffers start filling at the first
  `browser_read_console` / `browser_read_network` call for that tab, and hold 200 entries each.
- **Screenshots accumulate.** Files land in `os.tmpdir()/agent-deck-browser/<session>/` with no
  reaper. The existing `reapStaleUploads` pattern is the obvious model if this ever matters.
- **`fullPage` screenshots attach the debugger** because they go through
  `Page.captureScreenshot` with `captureBeyondViewport`. Harmless today; worth re-checking if the MCP
  tools are ever enabled for Codex sessions that also run the official client on the same tab.
- **No downloads, file uploads, native dialogs, or auth flows.** Front A keeps `allowDownload` as a
  stub, and the MCP surface has no equivalent.
- **Caps are shared.** 8 tabs per session and 24 globally, across both fronts. A busy session can
  crowd out others; the error message tells the user to close tabs elsewhere.

## Post-implementation fix: background key delivery

Electron delivers `webContents.sendInputEvent` only to a **focused** window
(`electron.d.ts`: "The `BrowserWindow` containing the contents needs to be focused for
`sendInputEvent()` to work"). Since the MCP surface is background-first, the first implementation of
`browser_press` — and therefore `browser_type` with `submit:true` — would have silently done nothing
on every background tab while still reporting success.

`EngineTab.canSendInputEvents()` now gates the input-event path on visible **and** focused, and the
script fallback reproduces the native effects explicitly instead of only dispatching an untrusted
`KeyboardEvent`: Enter submits the owning form or activates a button or link, Tab moves focus to the
next visible focusable element, and a single character is inserted into the focused field. All of it
is skipped when the page called `preventDefault` on keydown, matching real key semantics. Results now
carry `delivery: 'input-event' | 'script'` plus the script path's `effect`, so a caller can tell which
path ran.

`paintWhenInitiallyHidden: true` is also pinned explicitly in the window options: background tabs must
keep painting for screenshots and layout reads. Electron already defaults it to true; pinning it
documents the dependency. **Still unverified against a real renderer**: whether `capturePage()` returns
real pixels for a window that was never shown. If it comes back blank, route the viewport path through
CDP `Page.captureScreenshot` the way `fullPage` already does.

## Deferred follow-ups

- Attached `WebContentsView` panel inside the session view, which closes the PLAN_6 visual-QA gap.
- `browser_cdp` plus the per-session setting that would make it safe to expose.
- Browser-level CDP endpoint for external Playwright or chrome-devtools-mcp clients. Still judged not
  worth it: Electron's debugger is page-scoped, so a usable `connectOverCDP` target needs synthesized
  browser-level `Target` and `Browser` domains.
- Reusing a real Chrome profile or login state.

## Validation performed

- `pnpm typecheck` passed.
- `pnpm test` passed 377 files and 3,163 tests, one file skipped.
- `pnpm build` passed; `git diff --check` clean.
- `bash scripts/file-level-review-expiry.sh` ran before this record was written.
- A test caught a real defect pre-merge: the first URL normalizer read `localhost:3000` as a
  `localhost:` scheme and rejected it.

## Support materials

Prompt-asset backups were intentionally discarded after the change landed: the pre-change content of
all three bundled assets is recoverable from git history at `9a8cf9aa`. The behavior record for this
plan is `ref/changelogs/recent-3-days/CHANGELOG_400_cross-adapter-browser-engine.md`.
