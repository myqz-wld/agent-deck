---
changelog_id: 674
changed_at: 2026-10-01
---

# Collapsible Feishu assistant settings

## Summary

The remote assistant settings now use the same collapsible section as other settings. The
remote output-rate caption shows the measurement window without exposing the polling interval.

## Changes

- Wrap the assistant form and unavailable states in the shared settings section. Keep the
  initial expanded state and remember the user's subsequent choice across settings visits.
- Keep the form mounted while collapsed so pending capability reads, autosave, failed drafts,
  and remembered Gateway choices survive. Hide the duplicate form heading while preserving
  accessible field labels and save/loading feedback.
- Replace the remote output-rate caption with "最近 60 秒". Local and remote both poll recent
  usage at a nominal 2.5-second interval; Local additionally receives live generation estimates.
  Remote continues to display recorded usage without a live-generation overlay.
- Document the collapsible assistant section in the README and update settings hierarchy and
  lifecycle tests for persisted collapse and autosave completion while hidden.

## Validation

- `pnpm typecheck`: passed, including architecture checks.
- `pnpm test`: 1,130 files and 6,989 tests passed; three files and six tests were skipped by the suite.
- Agent Deck Browser inspected an isolated page using the actual components, production CSS,
  and synthetic remote preferences. Screenshots and snapshots confirmed the expanded and
  collapsed layouts, collapse persistence after reload, and the concise rate caption. The
  preview tab was closed and temporary preview files were removed.
- `git diff --check`: passed.
- All existing changelog dates were checked; no rebucketing was needed.

## Do Not Split Protection

None. All changed source and test files remain below 500 lines.

## Notes

Renderer-only change. No provider, transport, schema, polling, or live-rate behavior changed.
Browser validation used simulated remote data, without editing a real remote configuration.
