---
changelog_id: 656
changed_at: 2026-09-29
---

# Provider Runtimes and Model Suggestions

## Summary

Upgrade the stable Claude, Codex, and Grok packages and supporting SDKs. Rebuild the macOS
arm64 installer with matching application and Worker runtimes, and refresh Codex model suggestions.

## Changes

| Package | Previous | Updated |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.283` | `0.3.285` |
| `@anthropic-ai/sdk` | `0.128.0` | `0.129.0` |
| `@openai/codex` | `0.158.0` | `0.159.2` |
| `@xai-official/grok` | `1.0.41` | `1.0.44` |
| `@modelcontextprotocol/sdk` | `1.30.1` | `1.31.0` |

- Refresh all matching native platform packages in the lockfile. Claude reports Claude Code
  `2.1.285`. ACP SDK remains at its latest stable version, `1.5.1`.
- Refresh MCP transitive dependencies Hono `4.13.10` to `4.13.11` and
  `@hono/node-server` `2.1.1` to `2.1.3`.
- Remove `gpt-6-terra` from shared MCP model suggestions and replace `gpt-6-sol` with
  `gpt-6.1-sol`, as explicitly requested. Align the existing schema test and normalization comment.
  Model validation remains free text; provider selection and inheritance semantics are unchanged.
- Document current bundled and supporting SDK versions in README.
- Recompute all changelog buckets; no existing records need moving. Root routing policy is unchanged.

## Validation

- Scoped pnpm upgrade and frozen offline install passed with lifecycle scripts disabled.
- Claude Agent SDK, Anthropic SDK, MCP client, and ACP SDK imports passed.
- Real Codex app-server and Grok ACP initialization passed with isolated temporary configuration
  and the application's initialization parameters. Both exited after stdin closed. No authenticated
  model requests were made.
- `pnpm typecheck` passed, including both architecture checks.
- `pnpm test`: 1,078 files and 6,663 tests passed; 2 files and 3 opt-in tests skipped.
- `pnpm verify:bundled-runtimes` passed, including the existing Grok remote sandbox canary.
- `pnpm dist:mac` passed, including Linux headless builds, production application build, and
  source/packaged macOS Worker sandbox checks.
- ASAR inspection confirmed all six provider/supporting package versions and the requested model
  description changes. All six application/Worker executable version checks matched the new versions.
- Archive membership checks covered 14,547 entries for private configuration and credential names.
  A scan of 273 packaged files found no current home or repository path strings.
- `hdiutil verify` passed for the generated DMG. The SQLite binding hash stayed unchanged.
- `git diff --check` passed. All changed source files remain below 500 lines.

## Prompt Asset Scope

- User custom points: none. The user's explicit removal and rename request authorized the exact
  model edits; no additional behavioral changes were introduced.
- Editable prompt asset: `src/main/agent-deck-mcp/tools/schemas/target-runtime.ts`, model description.
- Paired check-only assets: `resources/claude-config/CLAUDE.md` and
  `resources/codex-config/CODEX_AGENTS.md`; neither duplicates these model suggestions or needs edits.
- Shared schema reuse preserves provider-specific controls. Existing schema tests passed, and the
  changed description introduces no resource links. README relative links resolve.
- The ignored local prompt-asset inventory was refreshed with a seven-day expiry and final hashes.
  No skill files or standing custom points changed; no skill validator was needed.

## Do Not Split Protection

No exceptions. The generated lockfile is exempt from the source file-size guardrail.

## Notes

- Generated app, DMG, and block map are under `build/dist/`. The installed application remains
  untouched. Installing the new build and restarting the running app require explicit approval.
- Worker executables were signed and verified during packaging. No Developer ID certificate is
  configured; the local installer performs application-level ad-hoc signing.
- Registry sources: [Claude Agent SDK](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.285),
  [Anthropic SDK](https://registry.npmjs.org/@anthropic-ai/sdk/0.129.0),
  [Codex](https://registry.npmjs.org/@openai/codex/0.159.2),
  [Grok](https://registry.npmjs.org/@xai-official/grok/1.0.44), and
  [MCP SDK](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.31.0).
