---
changelog_id: 680
changed_at: 2026-10-14
---

# Provider runtime and README refresh

## Summary

Refresh the bundled Claude and Grok stable releases, confirm Codex and related SDKs are current,
and reduce the project README to getting started, permissions, development, and documentation.

## Dependencies and documentation

| Package | Previous | Current |
|---|---|---|
| Claude Agent SDK | 0.3.296 | 0.3.299 |
| Bundled Claude Code | 2.1.296 | 2.1.299 |
| Grok CLI | 1.0.50 | 1.0.52 |
| Codex CLI | 0.162.1 | 0.162.1 |
| Anthropic API SDK | 0.133.0 | 0.133.0 |
| ACP SDK | 1.8.0 | 1.8.0 |
| MCP SDK | 1.32.1 | 1.32.1 |

- Keep the existing dependency range styles and matching native platform package versions.
  Only Claude Agent SDK, Grok, and their platform packages change in the lockfile.
- Reduce README from 89 to 47 lines, removing native permission mappings, internal collaboration
  contracts, and logging implementation details. Keep user-facing permission guidance and local links.
- Maintain the complete bundled version table in `resources/README.md`.
- Application and macOS Worker packaging use the same provider dependencies. No adapter source
  changes were required for these patch releases.

## Validation

- Scoped installation and frozen offline installation passed with lifecycle scripts disabled.
- Claude Agent SDK, Anthropic SDK, ACP SDK, and MCP client imports passed.
- Native executables report Claude Code 2.1.299, Codex 0.162.1, and Grok 1.0.52.
- Isolated Codex app-server and Grok ACP processes accepted the application's initialization payloads
  and exited after stdin closed. No authenticated model requests were made.
- Typecheck and architecture checks passed. Full tests passed: 7,254 tests and 1,156 files;
  six opt-in tests and three files skipped. The command used four workers and a 20-second test timeout.
- Bundled runtime preflight and the existing Grok remote sandbox canary passed.
- `pnpm dist:mac` passed, including reproducible headless builds, application build, and source and
  packaged Worker sandbox checks.
- ASAR metadata and all six application/Worker executable checks matched the version table.
- Archive membership checks covered 15,298 entries. Content scans covered 275 physical files,
  including binaries and source maps, without local machine identifiers or known private values.
- DMG integrity, README links, unchanged build-input fingerprints, SQLite binding integrity, and
  whitespace checks passed.

## Do Not Split Protection

No production or test source files changed. The generated lockfile is exempt.

## Handoff

Preserve installed applications, running processes, external CLI overrides, and user configuration.
Before installation, regenerate package metadata against the clean committed source and repeat final
archive and Worker verification. Generated installer metadata and checksums live in `build/dist/`.
The managed installer requires explicit approval to replace the running application and pause its
own background services; packaging alone does not activate these versions.

Sources: [Claude Agent SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.299),
[Grok registry metadata](https://registry.npmjs.org/@xai-official/grok/1.0.52), and
[Codex stable release](https://github.com/openai/codex/releases/tag/rust-v0.162.1).
