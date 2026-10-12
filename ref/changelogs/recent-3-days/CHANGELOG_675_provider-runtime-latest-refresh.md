---
changelog_id: 675
changed_at: 2026-10-11
---

# Provider Runtime Latest Refresh

## Summary

Refresh the bundled Claude, Codex, and Grok runtimes and supporting SDKs to the npm latest releases.
Prepare a validated macOS arm64 installer with matching application and Worker executables.

## Changes

| Package | Previous | Updated |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.285` | `0.3.296` |
| `@anthropic-ai/sdk` | `0.129.0` | `0.133.0` |
| `@openai/codex` | `0.159.2` | `0.162.1` |
| `@xai-official/grok` | `1.0.44` | `1.0.50` |
| `@agentclientprotocol/sdk` | `1.5.1` | `1.8.0` |
| `@modelcontextprotocol/sdk` | `1.31.0` | `1.32.1` |

- Refresh matching native platform packages while preserving existing version-range styles.
  The Claude executable reports Claude Code `2.1.296`. Alpha tags are excluded.
- Recognize ACP 1.8 `subagent_update`, `session_message`, and `session_message_chunk` variants
  in the Grok translator. Agent Deck does not advertise the required subagent capability, so these
  updates emit no parent conversation events and preserve buffered parent text.
- Add three regression cases for parent transcript integrity and document bundled versions in
  `resources/README.md`, preserving the separately simplified project README.
- Preserve the user's external Grok executable and configured path, as explicitly requested.
- Rebucket 34 existing changelogs by their original dates and update affected bucket indexes.
  Record content and the root routing policy are unchanged.

## Validation

- Scoped dependency installation and frozen offline installation passed with lifecycle scripts disabled.
  No unrelated dependency versions changed.
- Claude Agent SDK, Anthropic SDK, ACP SDK, and MCP client imports passed.
- Real Codex app-server and Grok ACP initialization accepted the application's initialization payloads
  with isolated temporary configuration, then exited after stdin closed. No authenticated model
  requests were made.
- `pnpm typecheck` passed, including both architecture checks.
- The initial full suite encountered seven subprocess timeouts and one UI wait assertion failure.
  The UI assertion and session-default checks passed on focused rerun. The final complete run,
  `pnpm run test --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --reporter=dot`, passed:
  1,139 files and 7,089 tests passed; three files and six opt-in tests skipped. Test timeout and
  concurrency settings were command-local; project test configuration was not changed.
- `pnpm verify:bundled-runtimes` passed, including the existing Grok remote sandbox canary.
- `pnpm dist:mac` passed, including reproducible Linux headless builds, production application build,
  and source/packaged macOS Worker sandbox checks.
- ASAR inspection confirmed all six package versions. All six application/Worker executable checks
  returned Claude Code `2.1.296`, Codex `0.162.1`, and Grok `1.0.50`.
- Archive membership checks covered 15,298 entries without private configuration or credential files.
  A content scan of 273 packaged files found no current username, home/checkout paths, or local
  application hook/MCP token values.
- `hdiutil verify` confirmed the DMG checksum. The SQLite binding hash remained unchanged.
- Runtime/source fingerprints did not change between the final test snapshot and packaging.
  README relative links and `git diff --check` passed.

## Do Not Split Protection

No exceptions. Changed production and test source files are below 500 lines; the lockfile is generated.

## Notes

- The generated app, DMG, and block map are under `build/dist/`. The installed application and its
  running processes remain untouched pending explicit installation/process approval.
- Refresh the generated artifact README, standalone build metadata, and SHA-256 checksums to match
  this installer. Existing historical installer directories are preserved.
- External Grok path and executable hashes were verified unchanged after packaging.
- The tested build snapshot includes independently authored browser/session lifecycle changes,
  subsequently committed separately. They are not authored by this refresh.
- Build metadata honestly marks the source worktree dirty. No commit, remote publication, or
  installation was performed as part of preparing this artifact.
- Worker executables were signed and verified during packaging. Application-level ad-hoc signing
  remains part of the existing local installation workflow.
- Registry sources: [Claude Agent SDK](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.296),
  [Anthropic SDK](https://registry.npmjs.org/@anthropic-ai/sdk/0.133.0),
  [Codex](https://registry.npmjs.org/@openai/codex/0.162.1),
  [Grok](https://registry.npmjs.org/@xai-official/grok/1.0.50),
  [ACP SDK](https://registry.npmjs.org/@agentclientprotocol/sdk/1.8.0), and
  [MCP SDK](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.1).
