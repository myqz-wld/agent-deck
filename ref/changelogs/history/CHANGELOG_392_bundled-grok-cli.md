---
changelog_id: 392
changed_at: 2026-07-24
---

# CHANGELOG_392_bundled-grok-cli: Use the bundled Grok Build runtime by default

## Summary

Grok Build now follows Claude and Codex: an empty binary-path setting launches the platform-native
Grok CLI shipped with Agent Deck, while an explicit absolute path still selects an external CLI.

## Changes

### Runtime and packaging

- Added the official `@xai-official/grok` distribution at `0.2.111`, including platform-specific
  compressed native packages for macOS, Linux, and Windows.
- Materialize the matching `.br` payload into a private temporary cache before launching, avoiding
  execution from `app.asar` and avoiding the package's user-home installation script.
- Added scoped pnpm/electron-builder handling so the Grok platform package is shipped in
  `app.asar.unpacked`; the npm package's postinstall is explicitly ignored.
- Kept `grokCliPath` as an external absolute-path override; `null` now resolves the bundled CLI.

### Settings and documentation

- Aligned the Grok Build settings hint with Claude and Codex: empty means the app-bundled runtime.
- Updated the settings type comments and README packaging/authentication guidance.

## Validation

- `pnpm install`
- `pnpm typecheck`
- `pnpm test` (358 files passed, 1 skipped; 3,050 tests passed, 1 skipped)
- `pnpm build`
- macOS `electron-builder --dir` smoke package confirmed `grok.br` under `app.asar.unpacked`.

## Do Not Split Protection

None. The new resolver remains below the repository's production file-size guardrail.
