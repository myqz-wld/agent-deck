---
changelog_id: 641
changed_at: 2026-09-04
---

# Codex quota visibility

## Summary

Hide the current and weekly `gpt-reserve` and `GPT-5.3-Codex-Spark` quota rows from
the Data panel, as requested in the supplied screenshot.

## Changes

- Filter the two named Codex quotas in the shared Local/Remote renderer using either
  their quota ID or displayed name, with case-insensitive matching. Provider snapshots,
  other quota windows, and token statistics retain their existing behavior.
- Reuse the existing empty-state message when filtering leaves no visible windows.
- Document the visibility rule in README Highlights. The required date-bucket scan
  moves CHANGELOG_565 into history without changing its contents; routing policy is unchanged.

## Validation

- `mise exec -- pnpm typecheck` passed architecture checks and Node/Web compilation.
- `mise exec -- pnpm test src/renderer/components/__tests__/DataPanel.test.tsx src/renderer/components/data-panel/DataPanelView.astra.test.tsx`
  passed both existing files and all 14 tests.
- SQLite binding SHA-256 remained unchanged; no runtime or dependency rebuild was needed.
- README links, backup manifest/original hash, refreshed inventory hash, changelog routing,
  and `git diff --check` passed.
- This small renderer change did not require a production build. Validation does not
  claim a live installed-app visual check; a running development renderer uses HMR.

## Do Not Split Protection

The only changed source file, `src/renderer/components/data-panel/DataPanelView.tsx`,
is 334 lines and remains below the 500-line guardrail.

## Documentation asset maintenance

- User Custom Points: require explicit approval for host process actions; no such action
  was needed. The convention-loading preference applies to runtime prompt assets, which
  are outside this change.
- Scope and change authorization come from the requested quota visibility change and
  the repository requirement to synchronize its README. The editable prompt-asset scope
  is only `README.md`, section `Highlights`; it has no adapter-specific counterpart.
- The seven-day inventory was refreshed in
  `.prompt-asset-improver/local/inventory.json`, including the final README hash.
- The original README and verified manifest are backed up under
  `.prompt-asset-improver/local/backups/20260905T061225Z/`. Restore the README from that
  directory if reverting the documentation change; application source is tracked by Git.
- No custom points, protocol instructions, asset metadata, or external links were changed.
