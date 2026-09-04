---
changelog_id: 456
changed_at: 2026-08-05
---

# CHANGELOG_456_codex-mcp-startup-observer-boundary: Port MCP startup observation

## Summary

Codex Agent Deck MCP startup observation no longer reads the desktop process context or uses the
desktop diagnostic serializer. A process adapter supplies one validated run identity while the
bounded startup state machine remains directly executable under Node.

## Startup observer boundary

- Added an explicit run-identity input and moved `getProcessRunId()` ownership into a desktop
  adapter used by the app-server client.
- Replaced generic diagnostic serialization with one fixed-field JSON record whose state,
  transitions, durations, thresholds, suppression counts, and run identity are all bounded before
  encoding.
- Invalid, multiline, secret-like, or overlong host run identities now fail closed to the literal
  `unknown`; raw thread IDs and provider failure content remain correlation-only and never enter
  the event.
- Preserved the 128-thread LRU, 10-second slow threshold, five-minute abnormal summary, recovery
  emission, clock rollback reset, tracker failure containment, and process-generation reset.

## Node boundary gate

- Added the MCP startup observer as the twenty-second executable Node 22 bundle candidate.
- Added a direct-import rule that rejects the desktop adapter, app-server client, runtime host,
  store, logger, run-context, safe-diagnostic, Node built-ins, Electron, and `electron-log`.

## Validation

- Focused observer and app-server generation coverage: passed, 2 files / 21 tests, including an
  invalid host run-identity regression.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 623 files / 4,797 tests plus 1 skipped.
- `git diff --check`, empty cached diff, changed TS/TSX line guard, and global changelog validation:
  passed; 108 structured changelogs, maximum id 456.

## Do Not Split Protection

Keep the observer, process-identity adapter, client construction, bounded-state tests, identity
redaction test, and executable boundary gates together. Process correlation, suppression state,
and fixed diagnostic encoding form one observability contract.

## Remaining boundary

The Codex app-server client and thread event translator still emit through desktop logger
singletons. Other provider process/settings ownership, Browser registry/tab ownership, and the
checkpoint worker transform remain extraction blockers. No shared development process was
started, restarted, stopped, or killed.
