---
changelog_id: 591
changed_at: 2026-08-11
---

# CHANGELOG_591_remote-transport-ui-convergence: Stabilize Remote transport and UI

## Summary

Remote connections no longer duplicate the first request admitted by a synchronous `connected`
observer. Disconnected and reconnecting Remote pages now fail closed before mounting business
consumers, the connection manager uses a compact single-column layout, and Local/Remote session
lists share the same structural presentation without reading across source boundaries.

## Changes

- Reorder SSH handshake completion so retained request bookkeeping is reconciled before the
  externally observable `connected` state. The strict response ledger remains unchanged: unknown,
  conflicting, queued, and otherwise inadmissible terminal responses are still fatal.
- Add one Remote page-availability boundary for Live, History, Pending, Teams, Issues, and Data.
  Reconnecting, offline, incompatible, and capability-missing states do not mount their business
  consumers and never fall back to Local data.
- Fence session, usage, Settings/Hook, Assets, Workspace-directory, new-session, Team, Issues, and
  plan-review work across same-identity disconnects and source/Core generation changes. Retired
  polling stops immediately and stale async results cannot repopulate a replacement source.
- Replace the connection manager's permanent split pane with a bounded single-column card list.
  Every connection carries its endpoint, state, relevant error, selection, lifecycle, edit, and
  confirmed-delete actions; add/edit forms open only on request.
- Extract shared session-card, header, lifecycle-section, and list-state primitives for Local and
  Remote. Remote Live omits the old Remote-only Closed section and decorative profile/load banner,
  while bounded pagination remains explicit and authoritative totals stay in the shared header.
- Remove redundant initial Issue filtering work, keep Remote Team adapters stable across unrelated
  Local-store updates, and ensure Remote header token rates never poll or subscribe to Local usage.

## Validation

- The deterministic SSH regression first reproduced two identical request frames for the first
  request admitted by a `connected` observer; first-connect and reconnect variants now each write
  exactly one frame. The final focused transport/reconnect set passed 33 tests, with wider SSH,
  daemon/Relay/Worker, and registry suites also green.
- The final convergence matrix passed 21 files / 138 tests, and the performance/race gate passed
  8 files / 76 tests, including disconnected zero-call behavior, stable polling counts, rapid
  generation changes, long connection copy, and an interactive 512-session list.
- The official Electron suite passed 905 files and 5,848 tests; 2 files and 3 tests retained their
  existing conditional skips.
- `pnpm typecheck`, `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, the Relay
  static check, `pnpm verify:macos-worker-sandbox`, and `git diff --check` passed.
- File-level review expiry was run before the final review. All 23 changed production TypeScript
  files remain below 500 lines; the largest is 499 lines.
- Full review details are recorded in `REVIEW_232_remote-transport-ui-convergence.md`.

## Do Not Split Protection

No exception is required. New availability, connection-card, and session-list presentation logic
was extracted into focused modules, and every changed production TypeScript file remains below the
repository limit.

## Notes

- This batch changes the desktop SSH client and renderer only. Relay and Worker artifacts are
  unchanged, so live server deployment is not required for this correction.
- macOS packaging, user installation, and installed-runtime acceptance remain T9 work. The durable
  implementation plan will be archived only after those live gates and the Feishu handoff finish.
