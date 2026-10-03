---
changelog_id: 650
changed_at: 2026-09-28
---

# macOS Installer Process Identity

## Summary

Make local installation require an explicit option before stopping the installed Agent Deck app,
and replace broad process-name termination with checks of the exact installed bundle's processes.

## Changes

- `pnpm install:local:mac` refuses a running installed app before rebuilding and rechecks that the
  app has exited immediately before replacement.
- `--stop-running` explicitly permits quitting the installed application. It requests graceful
  exit, waits, and uses a bounded SIGTERM fallback for verified PIDs only.
- Match executable paths under `/Applications/Agent Deck.app/Contents/`, capture process start
  times, and revalidate before each signal. Other copies and similarly named helpers are excluded.
- Abort on ambiguous main processes, new process identities, inspection failure, or exit timeout.
  Do not escalate to SIGKILL. Existing staging, signing, installed validation, and rollback remain.
- Document the option and its application-session interruption risk in README and CLI help.

## Validation

- Targeted installer tests: 2 files and 17 tests passed.
- Architecture and TypeScript checks passed.
- Full `pnpm test`: 1,037 files and 6,442 tests passed; 2 files and 3 opt-in tests skipped.
- Read-only inspection parsed the live macOS process table and identified the installed app.
- CLI help and whitespace checks passed; all changed scripts are below 500 lines.

## Do Not Split Protection

None. Process inspection and shutdown are isolated in `scripts/local-macos-processes.mjs`.

## Notes

See [the targeted safety repair record](../../reviews/recent-week/REVIEW_280_macos-installer-process-identity.md)
for regression coverage and the remaining process-inspection race boundary.
