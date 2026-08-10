---
changelog_id: 454
changed_at: 2026-08-05
---

# CHANGELOG_454_codex-generation-diagnostics-boundary: Port Codex lifecycle diagnostics

## Summary

The Codex app-server generation controller no longer imports the desktop logger or diagnostic
singletons. Readiness, boundary, recycle, termination, and extra-root observations flow through an
explicit diagnostics port whose desktop implementation preserves the existing fixed logging.

## Lifecycle boundary

- Added a complete generation diagnostics contract for thread-boundary success/failure,
  initialization retry, process termination failure, skills extra-root failure, and generation
  recycle outcomes.
- Moved logger scoping, safe error summaries, fixed event fields, slow-boundary severity, and
  redaction into the desktop diagnostics adapter.
- Preserved generation fencing, 30-second control-plane deadlines, shared readiness, bounded
  SIGTERM-to-SIGKILL retirement, pending rejection, and synthetic terminal notification behavior.
- Contained diagnostics-port failures so logging cannot change a successful provider result or
  override the authoritative lifecycle error.

## Node boundary gate

- Added the Codex generation controller as the twentieth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, the desktop diagnostics adapter,
  thread-boundary logger, runtime-host, store, and utility singleton dependencies in the
  controller.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty Node 22 bundle
  candidates.
- Focused generation/client/recycle coverage: passed, 3 files / 31 tests, including a diagnostics-
  failure containment regression.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 622 files / 4,787 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 106 structured changelogs, maximum id 454.

## Do Not Split Protection

Keep the generation controller, diagnostics port and adapter, client wiring, lifecycle tests, and
executable boundary gate together. Readiness, retirement, terminal publication, and diagnostics
containment form one control-plane contract.

## Remaining boundary

Other Codex app-server modules still own desktop logging and Browser bootstrap policy. Additional
provider settings/process ownership, Browser, and checkpoint worker transforms remain extraction
blockers. No shared development process was started, restarted, or stopped.
