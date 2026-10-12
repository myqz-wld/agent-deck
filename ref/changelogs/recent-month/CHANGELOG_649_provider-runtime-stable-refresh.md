---
changelog_id: 649
changed_at: 2026-09-28
---

# Provider Runtime Stable Refresh

## Summary

Refresh the stable Claude and Codex runtimes and supporting protocol SDKs, and rebuild the macOS
arm64 application with matching application and Worker provider packages.

## Changes

| Package | Previous | Updated |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.280` | `0.3.283` |
| `@openai/codex` | `0.156.0` | `0.158.0` |
| `@agentclientprotocol/sdk` | `1.5.0` | `1.5.1` |
| `@modelcontextprotocol/sdk` | `1.30.0` | `1.30.1` |

- Update all eight Claude native platform packages and six Codex native platform aliases in the
  lockfile. The Claude runtime reports Claude Code `2.1.283`.
- Retain Grok `1.0.41` and Anthropic SDK `0.128.0`, which remain the official stable versions.
  Grok's `1.0.43` alpha is outside this stable refresh.
- Refresh MCP transitive dependencies resolved by pnpm: Hono `4.13.10`, JOSE `6.2.12`,
  proxy-addr `2.0.8`, and the express-rate-limit dependency on ip-address `10.7.2`.
- Synchronize README runtime and protocol SDK versions. Preserve existing provider resolution,
  packaging, and prompt assets.
- Recompute all changelog date buckets; existing records remain in their correct buckets. Add
  this record to the recent-three-day index under the unchanged root routing policy.

## Validation

- Scoped pnpm update and frozen, offline installation passed with lifecycle scripts disabled.
- Claude Agent SDK, Anthropic SDK, ACP SDK, and MCP client imports passed.
- Real Codex app-server and Grok ACP initialization accepted the application's initialization
  payloads with isolated temporary configuration, then exited cleanly after stdin closed.
  No authenticated model requests were made.
- `pnpm typecheck` passed, including both architecture checks.
- `pnpm test`: 1,036 files and 6,429 tests passed; 2 files and 3 opt-in tests skipped.
- `pnpm verify:bundled-runtimes` passed, including the existing Grok remote sandbox canary.
- `pnpm dist:mac` passed, including reproducible Linux headless builds, production bundles,
  and source/packaged macOS Worker sandbox checks.
- ASAR inspection confirmed all six provider/supporting SDK versions and checked 14,017 entries
  for local configuration and credential files. All six application/Worker executable checks
  returned Claude Code `2.1.283`, Codex `0.158.0`, and Grok `1.0.41` as expected.
- Bundle content inspection found no current personal home, checkout, or validation-workspace
  paths in 273 files. Grok contains generic macOS temporary-directory prefixes as runtime strings.
- `hdiutil verify` confirmed the generated DMG checksum. The SQLite binding hash remained
  unchanged after installation, testing, and packaging.

## Do Not Split Protection

No production source files changed. The generated lockfile is exempt from the file-size guardrail.

## Notes

- The app, DMG, and block map are available under `build/dist/`. The installed application was
  not replaced or restarted; those actions require explicit approval under Host Runtime Safety.
- Worker executables were signed and verified during packaging. No Developer ID certificate is
  configured; the local installation workflow performs application-level ad-hoc signing.
- Official registry references: [Claude Agent SDK](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.283),
  [Codex](https://registry.npmjs.org/@openai/codex/0.158.0),
  [Grok](https://registry.npmjs.org/@xai-official/grok/1.0.41),
  [Anthropic SDK](https://registry.npmjs.org/@anthropic-ai/sdk/0.128.0),
  [ACP SDK](https://registry.npmjs.org/@agentclientprotocol/sdk/1.5.1), and
  [MCP SDK](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.30.1).
