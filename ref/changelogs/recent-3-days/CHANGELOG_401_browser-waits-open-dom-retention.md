---
changelog_id: 401
changed_at: 2026-07-27
---

# CHANGELOG_401_browser-waits-open-dom-retention: Harden browser readiness and artifacts

## Summary

The cross-adapter in-app browser now has a deterministic `browser_wait` readiness tool, snapshot
refs for open shadow roots and same-origin nested frames, and seven-day screenshot retention.
Interactions remain ref-only, browser state remains session-owned in the engine registry, and Codex
continues to use the official Browser plugin rather than the MCP browser surface.

## Changes

### Bounded readiness

- Add `browser_wait` as the fourteenth MCP browser tool for adapters whose runtime profile enables
  the browser surface. External callers remain denied.
- Support `kind:"selector"` with `attached`, `visible`, `hidden`, and `detached` states. Selectors
  are readiness queries only and never become interaction targets.
- Support `kind:"network-idle"` with a caller-bounded quiet window. MCP tabs arm request lifecycle
  tracking before their first navigation, while `browser_read_network` history still starts only
  at its first call.
- Track requests through `Network.loadingFinished` or `Network.loadingFailed`; receiving response
  headers no longer marks a request complete.
- Bound waits to 30 seconds, selector polling to 100 ms, and the default network quiet window to
  500 ms.

### Open-DOM refs

- Traverse the top document, open shadow roots, and accessible same-origin nested frames in
  deterministic DOM order, flattened into the existing `<generation>-<index>` ref format.
- Keep frame-host chains beside stored elements so click, type, and scroll operations bring every
  containing frame and the target into view.
- Construct input and keyboard events in the target document's realm, and follow deep active
  elements through frames and open shadow roots for background key fallback.
- Report document, open-shadow, same-origin-frame, inaccessible-frame, and scan-limit coverage.
  Cross-origin/OOPIF frames increment `inaccessibleFrames`; closed shadow roots are explicitly
  `not-observable` because page APIs cannot enumerate them.
- Cap each traversal at 20,000 DOM nodes, including text nodes. A capped selector scan cannot claim
  `hidden` or `detached`, because absence was not proven.

### Screenshot retention

- Move screenshot persistence out of the MCP handler into a dedicated guarded store beneath
  `os.tmpdir()/agent-deck-browser/<session>/`.
- Use private, collision-resistant generated filenames and preserve the existing saved-path plus
  optional inline-image result.
- Reap generated PNGs older than seven days at startup and opportunistically at most once per day.
  Unexpected entries and symlinks are skipped; canonical directory checks prevent cleanup outside
  the managed root.

### Agent guidance

- Align Claude and Grok bundled instructions on the `browser_wait` contract, ref invalidation after
  navigation, open-DOM coverage, and non-retroactive log history.
- Keep Codex adapter facts distinct: Codex still drives the official Browser plugin and receives no
  `browser_*` MCP tools. Its guidance now explicitly re-snapshots after navigation and reports
  missing embedded-content coverage rather than inventing targets.

### Standalone review hardening

- Install a deny-by-default Electron permission request/check/device/display policy once per
  non-persistent owner partition before its first navigation.
- Run page reads and probes without a synthetic user gesture; reserve activation for explicit
  interaction calls.
- Force-destroy automation tabs so a hostile `beforeunload` handler cannot leave a renderer alive
  after MCP or Codex reported successful closure.
- Dispose session-owned browser state from direct close/delete, mark-closed, scheduler close/purge,
  handoff, rollback, and app-quit paths.
- Normalize key aliases and reproduce target-aware background defaults for editing, caret/select
  movement, focus traversal, activation/submission, scrolling, and native-dialog Escape.
- Make selector evaluation itself honor the caller's wall-clock deadline, and keep post-header
  network failures in history.
- Collect optional snapshot text incrementally inside the shared node budget rather than reading an
  unbounded `body.innerText`.
- Enforce full-page `maxWidth` in physical pixels on HiDPI displays, impose a 16-million-pixel
  capture ceiling, and skip base64 allocation when the PNG will be path-only.
- Pin the Claude/Grok-enabled and Codex-disabled browser surface through actual runtime-profile
  registration tests, and correct per-tool MCP annotations.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 379 files / 3,196 tests, with one test skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- A real Electron hidden-window fixture verified open shadow roots, two nested same-origin frames,
  continuous refs, frame-depth metadata, frame clicks, frame input, and selector waits.
- A second committed real-Electron boundary fixture verified remote permission denial, probe versus
  interaction user activation, background key effects, force-close through `beforeunload`, selector
  wall-clock timeout, and Retina-aware full-page width. The user-requested standalone
  `gpt-5.6-sol` / `max` review completed full scope coverage; its repair verification and live
  Claude/Grok/Codex client checks remain.

## Do Not Split Protection

- Keep Codex protocol quirks in `src/main/browser-use/fronts/codex-pipe.ts`.
- Keep session browser state in the engine registry, never an MCP request or transport.
- Add future browser tools through names, external policy, schema, and browser-tool registration;
  do not grow the 488-line `tools/index.ts`.
- Keep browser safety semantics aligned across all three bundled prompt assets, with only
  adapter-surface wording allowed to differ.

## Notes

This hardening follows
`ref/plans/recent-3-days/PLAN_19_cross-adapter-browser-engine.md`. Cross-origin frame refs, piercing
closed shadow roots, raw CDP, downloads/uploads, site-specific auth automation, and an attached
`WebContentsView` remain out of scope.
