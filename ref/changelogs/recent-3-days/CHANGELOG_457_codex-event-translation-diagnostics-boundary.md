---
changelog_id: 457
changed_at: 2026-08-05
---

# CHANGELOG_457_codex-event-translation-diagnostics-boundary: Port translation diagnostics

## Summary

Codex app-server notification translation and stream-error classification no longer import desktop
loggers. Ignored future item types and heuristic-only retry matches flow through optional bounded
diagnostic callbacks supplied by the desktop thread loop.

## Translation boundary

- Changed the event translator to depend on the protocol notification contract instead of the
  concrete app-server client and removed its logger singleton.
- Added an ignored-item diagnostic callback; non-string item types are normalized to `unknown`, and
  callback failures cannot change or interrupt business event translation.
- Removed logger ownership from the stream-error classifier and added an equivalent callback for
  heuristic-only transient matches. Fatal phrases and regexes still win before transient matching,
  and callback failures cannot alter the authoritative retry classification.
- Added a desktop diagnostics adapter that preserves the existing scoped log messages, bounds
  ignored item-type values to a conservative token grammar, and remains outside the translator.
- Wired both callbacks at the existing desktop thread-loop boundary without adding a local fallback
  or changing emitted message, tool, file, collaboration, token, retry, or terminal events.

## Node boundary gate

- Added the Codex event translator and its transitive stream classifier as the twenty-third
  executable Node 22 bundle candidate.
- Added a direct-import rule that rejects the app-server client, desktop diagnostics adapter,
  runtime host, store, utilities, Node built-ins, Electron, and `electron-log`.

## Validation

- Focused translation, collaboration, and diagnostics coverage: passed, 3 files / 38 tests,
  including ignored-item and heuristic-retry diagnostics failure containment.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 624 files / 4,802 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; both touched legacy boundary files are 498 lines, 109 structured changelogs,
  maximum id 457.

## Do Not Split Protection

Keep the translator, stream classifier, diagnostics adapter, desktop thread-loop wiring, focused
translation tests, and executable boundary gates together. Retry classification and its user-facing
event must never diverge because an optional diagnostic path changes.

## Remaining boundary

The Codex app-server client and thread lifecycle still emit through desktop logger singletons.
Other provider process/settings ownership, Browser registry/tab ownership, and the checkpoint
worker transform remain extraction blockers. No shared development process was started, restarted,
stopped, or killed.
