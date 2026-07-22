---
review_id: 166
reviewed_at: 2026-07-22
baseline_commit: 62690e5a8254dd4faa8eed8d93b4718b7a272bdd
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Lifecycle-record rebucketing and index maintenance are mechanical archive work."
---

# REVIEW_166_node-repl-sandbox-protocol: Codex browser sandbox metadata compatibility

## Scope and method

This debug review traced Agent Deck's app-server thread configuration, the effective `node_repl`
MCP configuration, and the upstream Codex sandbox-state wire format across release tags. Codex
`0.140.0` sent both `permissionProfile` and required `sandboxPolicy`; `0.142.0` and later removed the
legacy field and retained `permissionProfile`. The failing browser runtime rejected that newer
payload before JavaScript execution. The review then exercised a deterministic legacy MCP fixture,
a modern passthrough fixture, the full repository suite, and a real Codex `0.145.0` app-server.

```review-scope
package.json
pnpm-lock.yaml
resources/bin/node-repl-sandbox-meta-proxy.cjs
src/main/adapters/codex-cli/app-server/__fixtures__/legacy-node-repl-mcp.cjs
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/node-repl-compat.test.ts
src/main/adapters/codex-cli/app-server/node-repl-compat.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/sdk-bridge/client-registry.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The reported failure was not caused by Agent Deck omitting `turn/start.sandboxPolicy`. Current Codex converted that legacy app-server input into a newer MCP `permissionProfile`, while the older `node_repl` still required the removed nested `sandboxPolicy`. | Added an Agent Deck-owned stdio bridge at the actual Codex-to-`node_repl` boundary and covered every in-app thread creation path. |
| MEDIUM | Supplying a guessed policy, or always coercing the current payload, could silently raise filesystem or network authority. | Translate only from the request's canonical profile, reject non-equivalent restricted profiles, and never default to full access. |
| MEDIUM | Always rewriting metadata would break current runtimes because `sandboxCwd` changed from a native path to a file URI at the same protocol boundary. | Forward the first request unchanged and activate legacy translation only after the exact missing-field error; current runtimes remain byte-semantically unchanged. |
| LOW | Reading or rewriting `~/.codex/config.toml` would create stale cross-session state and risk leaking effective server configuration. | Use `config/read`, extract only `mcp_servers.node_repl`, and inject a complete override into that one Agent Deck thread without logging its environment. |

## Validation evidence

- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- Focused compatibility and app-server client suites passed 20 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed 325 files and 2,931 tests with one explicit credentialed live-smoke skip.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- The repository postinstall rebuilt `better-sqlite3` for Electron after dependency installation.
- A real Codex `0.145.0` app-server initialized the wrapped current `node_repl`, emitted
  `mcpServer/startupStatus/updated` with `status: ready`, and completed a direct modern `js` call.
- A real Codex `0.145.0` app-server routed all three built-in permission levels through the bridge
  to the legacy fixture; read-only, workspace-write, and full-access produced their matching legacy
  policies while converting the file-URI cwd to its native absolute path.
- The legacy fixture returned the reported `-32602` error on its first call, accepted the translated
  retry, and observed the expected native cwd and legacy policy before the synthetic
  `browser.documentation()` call completed.

## Fixes landed

- Added a bundled JSONL stdio proxy that preserves general MCP traffic and retries only the legacy
  sandbox-schema rejection.
- Added conservative profile-to-policy conversion matching the legacy Codex MCP wire shape.
- Added per-generation, per-cwd effective-config caching and thread-local proxy injection.
- Updated packaged Claude and Codex dependencies and lockfile platform packages.

## Residual risk and boundaries

- The original `26.611` binary is not present on this machine, so its exact rejection is represented
  by a deterministic MCP fixture using the captured error. The real smoke covers the complementary
  modern-runtime path and packaging command shape.
- A separate current Browser Plugin issue, `Cannot redefine property: process`, still prevents a
  full live `browser.documentation()`/Gmail assertion in this environment. It occurs after MCP
  sandbox validation and is independent of the fixed missing-field failure; it remains tracked
  outside this change.
- Remote-environment `node_repl` servers are deliberately not wrapped because Agent Deck's local
  Electron executable and bundled proxy are not guaranteed to exist in that environment.
- `client.ts` remains at the repository's 500-line ceiling. The conversion and configuration logic
  were extracted; any new client responsibility should trigger a further lifecycle-module split.

## Follow-ups

After installing the rebuilt app, fully restart Agent Deck and Codex, then repeat the browser setup
against the user's actual Chrome or in-app browser session. No unresolved sandbox-policy code
finding remains.
