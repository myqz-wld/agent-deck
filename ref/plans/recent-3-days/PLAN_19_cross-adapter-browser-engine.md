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
hardening_commits: 53830804, 28074a89, e4db8ffd, f965b127, 506a20d9
related_changelog: CHANGELOG_400, CHANGELOG_403
related_reviews: REVIEW_175, REVIEW_177, REVIEW_182
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
| Engine | `src/main/browser-use/engine/{types,registry,tab,cdp,actions,scripts,key-script}.ts` | provider-neutral registry, CDP, actions, traversal, and hidden-key fallback |
| Codex front | `src/main/browser-use/fronts/codex-pipe.ts` | 407 LOC, replaces the deleted 497-LOC `iab-session.ts` |
| Session helper | `src/main/browser-use/session-browser.ts` | owner key + idempotent disposal |
| MCP tools | `agent-deck-mcp/tools/browser-tools.ts`, `tools/schemas/browser.ts`, `tools/handlers/browser/{shared,tabs,interact,inspect}.ts` | 14 tools |
| Wiring | `runtime-profiles.ts`, `agent-deck-mcp/types.ts`, `tools/index.ts`, `tools/schemas.ts` | names, allow-list, per-adapter gating |
| Lifecycle | `session/manager/lifecycle.ts`, `session/lifecycle-scheduler.ts`, `hand-off-session/source-finalization.ts`, `codex-cli/sdk-bridge/create-session-rollback.ts`, `index/lifecycle-hooks.ts` | disposal on every terminal close/delete/scheduler/handoff/rollback/quit path |
| Prompt assets | `resources/{claude-config/CLAUDE.md,grok-config/GROK_AGENTS.md,codex-config/CODEX_AGENTS.md}` | 14 added lines each, identical safety rules |
| Tests | `browser-use/engine/__tests__/{_fakes,registry,cdp,actions}`, `agent-deck-mcp/__tests__/browser-tools.test.ts` | 725 LOC, +51 tests |

Tool surface: `browser_open`, `browser_tabs`, `browser_navigate`, `browser_close`,
`browser_wait`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press`,
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
7. Readiness uses one bounded `browser_wait` tool with selector and network-idle modes. Selectors
   never become interaction targets.
8. Same-origin nested frames and open shadow roots keep the existing flat
   `<generation>-<index>` ref format. Coverage metadata exposes inaccessible frames and scan caps.
   Cross-origin/OOPIF frames remain inaccessible; closed shadow roots cannot be enumerated by page
   APIs and are explicitly reported as `closedShadowRoots: "not-observable"`.
9. Generated screenshots have seven-day retention, reaped at startup and opportunistically at most
   once per day. Cleanup skips unknown entries and symlinks instead of assuming ownership.

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
- **Do not broaden Codex's CDP ownership.** Codex sessions keep exactly the domains the official
  client enables itself until a Codex operation explicitly needs more. MCP tabs arm Network request
  lifecycle tracking in `browser_open`, before their first navigation, so `browser_wait` can observe
  network idle; this does not make `browser_read_network` history retroactive.
- **Prompt assets are edited in triples.** `resources/claude-config/CLAUDE.md`,
  `resources/grok-config/GROK_AGENTS.md`, and `resources/codex-config/CODEX_AGENTS.md` must keep
  identical safety semantics; wording may differ only on adapter-surface facts. Do not leave `.bak`
  files inside `resources/`: that directory is packaged into the app bundle.
- **Review scope**: the renames under `src/main/browser-use/` mean `REVIEW_177` no longer maps to
  current paths. A fresh standalone `gpt-5.6-sol` / `max` review covered the engine, Codex front,
  MCP browser tools, lifecycle, prompts, and tests. Its 12 findings were repaired in `506a20d9` and
  the same reviewer verified all 12 closed with `Coverage: COMPLETE` in `REVIEW_182`.

## Known functional gaps

These are real limitations of the shipped surface, not bugs to file blindly. Pick them up only when a
concrete use case appears.

- **Open-DOM traversal has explicit boundaries.** Snapshots and selector waits traverse open shadow
  roots and accessible same-origin nested frames, flattening them into the existing ref generation.
  Cross-origin/OOPIF frames remain inaccessible, and closed shadow roots are structurally
  unobservable from page APIs. Every traversal is capped at 20,000 DOM nodes (elements plus text);
  coverage metadata reports inaccessible frames, the explicit closed-shadow boundary, and a reached
  cap.
- **Ref state lives in the page.** Refs are stored on `window.__agentDeckBrowserRefs__`, so any
  navigation or reload wipes them and the next click reports a stale ref. That is intended, but it
  means "click, then click again after navigation" always needs a re-snapshot.
- **Waits cover readiness, not arbitrary page predicates.** `browser_wait` handles bounded selector
  states and network idle, but does not expose arbitrary JavaScript predicates, navigation events,
  or long-running watches.
- **Log capture is not retroactive.** Console and network buffers start filling at the first
  `browser_read_console` / `browser_read_network` call for that tab, and hold 200 entries each.
- **Screenshot cleanup is time-based.** Generated PNGs older than seven days are removed at startup
  and at most once per day thereafter. Current-session screenshots are not quota-limited before the
  retention window expires.
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
script fallback normalizes aliases and reproduces native effects explicitly instead of only
dispatching an untrusted `KeyboardEvent`: text insertion/deletion and caret movement, textarea
newlines, form submission, button/checkbox activation, select movement, Tab focus movement, page
scrolling, and native-dialog Escape. All of it is skipped when the page called `preventDefault` on
keydown, matching real key semantics. Results carry `delivery: 'input-event' | 'script'` plus the
script path's `effect`, so a caller can tell which path ran.

`paintWhenInitiallyHidden: true` is also pinned explicitly in the window options: background tabs must
keep painting for screenshots and layout reads. Electron already defaults it to true; pinning it
documents the dependency. A real hidden Electron window returned non-empty pixels through
`capturePage()`. Full-page capture still intentionally uses CDP `Page.captureScreenshot`.

## P0/P1 hardening follow-up

- `browser_wait` provides one bounded readiness surface: selector states
  (`attached` / `visible` / `hidden` / `detached`) and network idle.
- Snapshots, selector waits, and ref interactions share a bounded traversal across the top document,
  open shadow roots, and same-origin nested frames. Ref syntax remains backward-compatible.
- Screenshot writes and cleanup are isolated in a guarded store with seven-day retention.
- Claude and Grok prompt assets describe the MCP wait and coverage contract. Codex guidance remains
  specific to the official Browser plugin and does not claim MCP browser availability.
- A user-requested standalone Codex review completed with full scope coverage. Five HIGH, six MEDIUM,
  and one LOW finding were repaired, then the same reviewer verified all 12 closed without a new
  finding. This is recorded accurately as one standalone reviewer, not a heterogeneous review.

## Standalone review repairs

`506a20d9` closes all 12 findings from the user-requested `gpt-5.6-sol` / `max` review:

- deny arbitrary remote-page permissions once per owner partition;
- remove synthetic user activation from snapshots, waits, evaluates, and other probes;
- force-destroy automation tabs so `beforeunload` cannot make close results dishonest;
- dispose browser owners on mark-closed, scheduler close/purge, and direct delete;
- normalize background key aliases and reproduce their target-aware native effects;
- enforce selector timeouts in the main process even when page evaluation stalls;
- finalize network history only on finished/failed so post-header resets stay visible;
- share the 20,000-node traversal budget with bounded text collection;
- enforce full-page `maxWidth` on HiDPI displays, cap output work, and avoid unused base64 copies;
- state that closed-shadow coverage is not observable instead of claiming it is counted;
- pin the Claude/Codex/Grok browser-surface matrix in registration tests; and
- advertise page mutation, idempotence, and open-world effects accurately per tool.

## Deferred follow-ups

- Attached `WebContentsView` panel inside the session view, which closes the PLAN_6 visual-QA gap.
- `browser_cdp` plus the per-session setting that would make it safe to expose.
- Browser-level CDP endpoint for external Playwright or chrome-devtools-mcp clients. Still judged not
  worth it: Electron's debugger is page-scoped, so a usable `connectOverCDP` target needs synthesized
  browser-level `Target` and `Browser` domains.
- Reusing a real Chrome profile or login state.

## Validation performed

- `pnpm typecheck` passed.
- `pnpm test` passed 379 files and 3,196 tests, with one test skipped.
- `pnpm build` passed; `git diff --check` clean.
- Hardening-focused engine, generated-script, MCP browser, screenshot-store, and bootstrap tests
  passed; the Node suite also passed 324 files / 2,732 tests with 54 files / 437 tests skipped for the
  expected Electron-versus-Node native SQLite ABI boundary.
- A real hidden Electron fixture verified non-empty viewport capture plus open shadow roots, two
  nested same-origin frames, continuous refs, frame interactions, and selector waits.
- A committed real-Electron boundary fixture additionally verified deny-by-default notification and
  geolocation policy, no user activation during snapshot/wait probes, explicit-click activation,
  hidden input/textarea/select/Dialog key defaults, force-close through `beforeunload`, a selector
  wall-clock timeout, and full-page `maxWidth` on a Retina display. It caught and drove the HiDPI
  screenshot correction before review handoff.
- `REVIEW_182` records the standalone `gpt-5.6-sol` / `max` audit and bounded repair pass: all 12
  findings are FIXED, no new finding was opened, and coverage is complete.
- `bash scripts/file-level-review-expiry.sh` ran before this record was written.
- A test caught a real defect pre-merge: the first URL normalizer read `localhost:3000` as a
  `localhost:` scheme and rejected it.

## Support materials

The original prompt-asset content remains recoverable from git history at `9a8cf9aa`. The P0/P1
prompt edits also have an ignored local backup manifest under
`.prompt-asset-improver/local/backups/20260727T112438Z/`. The review-driven prompt/tool-description
edits have a second ignored manifest under
`.prompt-asset-improver/local/backups/20260727T121825Z/`; no backup is stored in packaged
`resources/`. Behavior records are
`ref/changelogs/recent-3-days/CHANGELOG_400_cross-adapter-browser-engine.md` and
`ref/changelogs/recent-3-days/CHANGELOG_403_browser-waits-open-dom-retention.md`.
