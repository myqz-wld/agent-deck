---
changelog_id: 380
changed_at: 2026-07-22
---

# CHANGELOG_380_node-repl-sandbox-compatibility: Restore browser runtime compatibility

## Summary

In-app Codex sessions now bridge the `codex/sandbox-state-meta` protocol change between current
Codex app-server releases and older browser-bundled `node_repl` servers. The bridge preserves the
active permission profile, fails closed when a legacy policy cannot represent it safely, and does
not edit user Codex configuration. Packaged Claude and Codex dependencies were also refreshed.

## Changes

### Version-aware node_repl metadata bridge

- Read each in-app session's effective Codex configuration through `config/read`, then wrap only
  its local stdio `node_repl` entry through a bundled, per-session proxy. User and project
  `config.toml` files remain unchanged.
- Forward modern MCP traffic unchanged. Only an exact legacy `-32602` response naming the missing
  `sandboxPolicy` field enables a single translated retry; subsequent calls on that connection use
  the detected legacy mode.
- Derive the legacy `sandboxPolicy` from the request's authoritative `permissionProfile`, including
  read-only, workspace-write, full-access, external-sandbox, and network settings. Convert the new
  `sandboxCwd` file URI back to the native path expected by the legacy runtime.
- Reject unknown profiles, restricted-read profiles, and non-workspace write grants that cannot be
  represented without increasing authority. No fallback selects a higher-permission policy.
- Apply the compatibility preflight to start, resume, fork, eager-start, and adopted thread paths,
  while leaving non-session Codex clients and non-local MCP environments untouched.

### Claude and Codex dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.211` to `0.3.217`.
- Updated `@anthropic-ai/sdk` from `0.111.0` to `0.112.5`.
- Updated `@openai/codex` from `0.144.5` to `0.145.0`, including platform packages in the lockfile.
- Reinstalled Electron native dependencies through the repository postinstall flow.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 325 files and 2,931 tests; one opt-in credentialed live smoke remained skipped.
- `pnpm build` and `pnpm logger:check` passed.
- Focused compatibility tests passed the exact legacy failure/retry, modern passthrough, fail-closed
  policy mappings, existing-policy preservation, session-config injection, and a fixture call that
  reaches `await browser.documentation()`.
- A real Codex `0.145.0` app-server smoke reported the proxied `node_repl` as `ready`, and a direct
  `js` MCP call carrying the modern `permissionProfile` metadata completed without an MCP error.
- A real Codex `0.145.0` app-server also routed read-only, workspace-write, and full-access metadata
  through the proxy to the legacy fixture, which observed the matching legacy policy and native cwd.

## Do Not Split Protection

None. Conversion and proxy behavior live in focused modules below the 500-line limit; the existing
app-server client remains at exactly 500 lines and contains only the lifecycle coordination seam.

## Related review

- `REVIEW_166_node-repl-sandbox-protocol.md`

## Deployment note

Agent Deck and Codex must be fully restarted after installing the rebuilt application so existing
app-server and `node_repl` processes do not retain the pre-fix configuration.
