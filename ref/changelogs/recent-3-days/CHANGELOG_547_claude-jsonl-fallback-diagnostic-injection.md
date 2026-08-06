---
changelog_id: 547
changed_at: 2026-08-05
---

# CHANGELOG_547_claude-jsonl-fallback-diagnostic-injection: Inject JSONL fallback diagnostics

## Summary

The shared Claude JSONL fallback helper no longer imports the desktop logger. Restart and recovery
callers now provide its bounded warning port through the existing dependency object.

## Fallback diagnostic ownership

- Added the required warning operation to `JsonlFallbackCtx`.
- Routed restart warnings through the injected restart host and recovery warnings through the
  recovery caller's current observer.
- Removed the helper's scoped desktop logger and added an internal best-effort warning guard.
- Added an architecture rule that prevents the fallback helper from importing the desktop logger.
- Kept the 499-line helper and both 499-line adjacent orchestrators below the repository limit.

## Preserved fallback behavior

- Native JSONL resume still bypasses continuation preparation and fresh-session construction.
- Phantom-fork healing retains application/CLI identity, mtime skew, restart-message freshness, and
  stale-history rejection semantics.
- Missing JSONL still prepares the immutable continuation before creating a fresh CLI thread that
  reuses the application session ID.
- Recovery cancellation after preparation still avoids session creation and user-visible fallback
  emission.
- Fallback publication remains create-first, information-second, and user-message-last.

## Direct evidence

- A new regression injects a warning observer that throws and proves a successful fallback remains
  successful.
- Existing helper tests retain native resume, cwd fallback, attachment, cancellation, failed
  startup, skip-first-emit, phantom-heal, and stale-heal coverage.
- Restart and recovery integration suites prove both callers supply the new required dependency.

## Validation

- Focused fallback/restart/recovery coverage: passed, 4 files / 60 tests.
- Complete Claude adapter coverage: passed, 126 files / 502 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 738 files / 5,034 tests plus 1 skipped.
- `jsonl-fallback.ts` and `recover-and-send-impl.ts` are 499 lines; `restart-controller.ts` is 485.
- The cached Git index remains empty; no shared development or Electron process was touched.

## Do Not Split Protection

Keep the required warning port, both caller bindings, helper guard, architecture prohibition, and
throwing-observer regression together. A partial caller migration would either break fallback or
restore desktop discovery inside the shared helper.

## Remaining boundary

`recoverer/recover-and-send-impl.ts` still owns its scoped desktop logger directly. The next bounded
slice should inject recovery diagnostics while preserving capture, cwd fallback, archive recovery,
cancellation, error publication, and continuation cleanup.
