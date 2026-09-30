---
changelog_id: 646
changed_at: 2026-09-22
---

# Provider Runtime and ACP Refresh

## Summary

Refresh the Claude, Codex, and Grok dependencies and package matching application and macOS Worker
runtimes. Recognize the new ACP advisory notice variant without interrupting streamed responses.

## Changes

### Dependencies and bundled runtimes

| Package | Previous | Updated |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.272` | `0.3.280` |
| `@anthropic-ai/sdk` | `0.125.0` | `0.128.0` |
| `@openai/codex` | `0.154.0` | `0.156.0` |
| `@xai-official/grok` | `1.0.30` | `1.0.41` |
| `@agentclientprotocol/sdk` | `1.4.0` | `1.5.0` |

- Match the official npm stable tags and update all corresponding native platform entries in the
  lockfile. Claude Agent SDK includes Claude Code `2.1.280`.
- Retain MCP SDK `1.30.0`, unrelated dependencies, package-manager conventions, and existing
  bundled executable resolution and packaging rules.

### ACP compatibility and documentation

- Explicitly recognize ACP 1.5 `notice` updates. Agent Deck does not advertise
  `clientCapabilities.session.notices`, so unsolicited advisory notices produce no persisted
  events and leave pending streamed text intact. Notices do not represent fatal turn errors.
- Add a regression test covering an error-severity notice between assistant text chunks.
- Synchronize the README dependency versions and retain its rebuild/reinstall guidance.
- Recompute changelog date buckets and move changelog 623 into history, updating both bucket
  indexes. The root routing policy remains unchanged.

## Validation

- Scoped dependency update and `pnpm install --frozen-lockfile --offline --ignore-scripts` passed.
- Claude Agent SDK, Anthropic SDK, and ACP module import checks passed.
- Native version checks returned Claude Code `2.1.280`, Codex CLI `0.156.0`, and Grok `1.0.41`.
- Real Codex app-server and Grok ACP initialization accepted the application's initialization
  payloads with isolated temporary configuration directories and exited cleanly after stdin
  closed. No authenticated model requests were made.
- `pnpm typecheck` passed, including both architecture checks.
- `pnpm test`: 1,032 files and 6,393 tests passed; 2 files and 3 opt-in tests skipped.
- Focused Grok protocol/translation checks: 4 files and 45 tests passed.
- `pnpm verify:bundled-runtimes` passed, including the Grok remote sandbox canary.
- `pnpm dist:mac` passed, including the production build and source/packaged Worker sandbox checks.
- `hdiutil verify` confirmed the generated DMG checksum is valid.
- ASAR inspection confirmed all five updated package versions. All six application/Worker
  executable checks returned the expected Claude, Codex, and Grok versions.
- Checked 14,017 ASAR entries for local configuration/log inclusion and 273 bundle files for
  personal home, checkout, and validation-workspace paths. No matches were found.
- The SQLite binding hash remained unchanged after installation, tests, and packaging.
- README local links, dependency scope, changelog routing, and `git diff --check` passed.

## Do Not Split Protection

None. The modified production file and new test remain below 500 lines. The generated lockfile
is exempt from the file-size guardrail.

## Notes

- The arm64 app, DMG, and block map are available under `build/dist/`. The installed application
  remains unchanged; replacement and restart require explicit approval under Host Runtime Safety.
- Worker executables were signed and verified during packaging. No Developer ID certificate is
  configured; the normal local installation workflow performs application-level ad-hoc signing.
- Official references: [Claude Agent SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.280),
  [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.156.0),
  [Grok package metadata](https://registry.npmjs.org/@xai-official/grok/1.0.41),
  [Anthropic SDK package metadata](https://registry.npmjs.org/@anthropic-ai/sdk/0.128.0),
  [ACP SDK package metadata](https://registry.npmjs.org/@agentclientprotocol/sdk/1.5.0), and
  [ACP notice semantics](https://agentclientprotocol.com/rfds/session-notices).
