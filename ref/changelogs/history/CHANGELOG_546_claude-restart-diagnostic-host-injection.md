---
changelog_id: 546
changed_at: 2026-08-05
---

# CHANGELOG_546_claude-restart-diagnostic-host-injection: Inject Claude restart diagnostics

## Summary

The Claude cold-restart controller no longer imports the desktop logger. Its existing required
restart host now owns persistence, publication, rename observation, and bounded diagnostics.

## Restart diagnostic ownership

- Extended `ClaudeRestartSessionHost` with the required restart warning port.
- Moved the scoped desktop logger into `restart-session-host.ts` beside the existing persistence,
  publication, and rename-event ownership.
- Routed permission-mode and sandbox continuation capture/cleanup warnings through the injected
  host.
- Made diagnostic observation best-effort so a throwing host cannot alter restart, rollback,
  single-flight, rename transfer, or continuation cleanup authority.
- Expanded the restart-controller architecture rule to reject all desktop utility imports.

## Preserved restart behavior

- Permission-mode and sandbox cold restarts still share one rename-aware single-flight map.
- Native resume and JSONL-missing fallback retain the exact application/CLI identity split.
- Capture failure remains non-authoritative when native JSONL can resume.
- Cleanup failure remains secondary after a completed restart.
- Restart failure still rolls persisted controls back and publishes the user-visible error.

## Direct evidence

- New controller tests inject a warning port that itself throws and prove capture and cleanup
  diagnostics cannot change successful permission-mode or sandbox restart results.
- The desktop-host test proves scoped warnings, persistence, publication, and rename unsubscription
  stay behind the same concrete host.
- Existing JSONL, fork-rename, rollback, and adapter-init suites retain lifecycle coverage.

## Validation

- Focused restart/host/init coverage: passed, 6 files / 23 tests.
- Complete Claude adapter coverage: passed, 126 files / 501 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 738 files / 5,033 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 499 lines and `restart-controller.ts` is 483 lines.
- The cached Git index remains empty; no shared development or Electron process was touched.

## Do Not Split Protection

Keep the required warning port, desktop logger implementation, best-effort controller calls,
architecture prohibition, and throwing-observer regressions together. A direct logger import or an
authoritative diagnostic failure would reintroduce desktop ownership or change restart semantics.

## Remaining boundary

`jsonl-fallback.ts` and `recoverer/recover-and-send-impl.ts` still import the desktop logger. The
next bounded slice should inject fallback diagnostics through its existing dependency object while
preserving phantom-fork healing, freshness, cancellation, and fallback decisions.
