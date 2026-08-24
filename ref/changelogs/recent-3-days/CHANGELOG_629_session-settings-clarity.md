---
changelog_id: 629
changed_at: 2026-08-24
---

# CHANGELOG_629_session-settings-clarity: Clarify session settings and Hook actions

## Summary

Session creation now explains project trust in user-facing language, terminal Hook actions fill the
available row, and Codex `SessionEnd` hooks use the three-second timeout accepted by the current
Codex runtime.

## Changes

### Project trust copy

- Replaced implementation terms such as native trust, non-interactive mode, provider gates, and
  native policy with direct descriptions of the resulting behavior.
- Kept `hooks`, `MCP`, `LSP`, `.codex`, and `rules` where those established terms communicate the
  exact project resources more clearly than a generic substitute.
- Clarified that Claude may use project settings in the current session even when durable trust is
  not saved, and that Codex tool calls plus new or modified hooks still require separate approval.

### Terminal Hook presentation

- Made install, repair, and uninstall actions fill the Hook status card width for Claude Code,
  Codex CLI, and Grok Build.
- Added an installed-state regression so the short `卸载` label cannot shrink the shared action.

### Codex SessionEnd timeout

- Emit a three-second timeout for `SessionEnd` while retaining five seconds for other Codex hooks.
- Treat the previous five-second managed `SessionEnd` entry as incomplete, allowing the Settings
  dialog to offer repair instead of reporting the outdated hook set as fully installed.
- Added focused coverage for emitted timeout values and legacy-entry detection.

## Validation

- `pnpm typecheck`
- `pnpm test`: 1,007 files and 6,309 tests passed; 2 files and 3 opt-in tests skipped.
- Focused project-trust, Hook-section, Settings-dialog, and Codex-hook-installer suites passed.
- The user-level Codex hooks file parses as JSON, its Agent Deck-owned `SessionEnd` timeout is 3,
  and the installed Codex runtime reads configuration without the prior clamp warning.
- `git diff --check`

## Do Not Split Protection

No exception is required. The changed production files remain below 500 lines.

## Notes

- Renderer changes can arrive through HMR in development.
- Main-process restart is deferred because terminating the running app would interrupt the active
  in-app session; the already-installed user-level hook entry was corrected immediately.

## Related record

- `ref/reviews/recent-3-days/REVIEW_263_session-settings-clarity.md`
