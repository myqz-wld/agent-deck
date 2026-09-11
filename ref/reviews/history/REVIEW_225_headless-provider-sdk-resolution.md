---
review_id: 225
reviewed_at: 2026-08-10
baseline_commit: 321d635260c9c36d72d3a3210dbd07698cfc148c
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and bucket-index maintenance are mechanical records."
---

# REVIEW_225_headless-provider-sdk-resolution: Headless provider SDK resolution

## Scope and method

This issue-specific self-review traced live Relay session creation through the desktop SSH client,
Local Worker capability and provider startup paths, Codex app-server logs, the loopback MCP broker,
and the sealed macOS Worker runtime loaded from `/dev/fd/18`. Neither `simple-review` nor
`deep-review` was invoked.

```review-scope
src/hosts/server-core/mcp-broker.test.ts
src/hosts/server-core/mcp-broker.ts
src/hosts/server-core/mcp-server.ts
src/hosts/server-core/provider-claude-host.ts
src/hosts/server-core/provider-claude-query-host.ts
src/hosts/server-core/provider-claude-sdk.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The headless MCP broker bypassed the bundler with bare ESM package imports. The macOS Worker loads its runtime from `/dev/fd/18`, so `@modelcontextprotocol/sdk` could not resolve and every remote Codex session failed while initializing the required Agent Deck MCP server. | Statically bundle the MCP server and Streamable HTTP transport, retaining the explicit test loader seam. |
| HIGH | The headless Claude provider reused the desktop-only dynamic SDK loader and would hit the same sealed-runtime resolution failure once a Remote Claude gateway became available. | Add a headless-only statically bundled Claude SDK loader and route all Server Core Claude query, usage, and fork paths through it. |

No confirmed source finding remains open.

## Validation and evidence

- Live Codex startup selected `gpt-5.6-sol`, authenticated successfully, and received HTTP 200 from
  the model catalog before required Agent Deck MCP initialization returned HTTP 500.
- Inspecting the live Broker instance produced `ERR_MODULE_NOT_FOUND` for
  `@modelcontextprotocol/sdk`, imported from `/dev/fd/18`.
- The rebuilt Local Worker runtime contains the static MCP module and headless Claude loader and no
  matching bare dynamic package import.
- `pnpm typecheck` passed, including architecture and core-node boundary checks.
- `pnpm vitest run src/hosts/server-core/mcp-broker.test.ts --reporter=verbose` passed 5 tests,
  including the default bundled-SDK path.
- `pnpm verify:linux-headless` passed the headless build, static/package checks, and deployment
  automation checks.
- `pnpm verify:macos-worker-sandbox` passed the signed helper and provider-native boundary checks.
- `pnpm test` passed 863 test files and 5,634 tests, with 2 files and 3 tests skipped.
- `pnpm build` and `git diff --check` passed.

## Fixes landed

- Removed runtime-resolved MCP SDK imports from the sealed Server Core runtime.
- Added a headless-only bundled Claude SDK boundary without changing the desktop loader.
- Added default MCP loader regression coverage.

## Residual risk

- Bundling the Claude SDK increases the headless runtime artifact size. The complete headless build,
  macOS sandbox verification, and production build pass; live Claude and Codex Relay acceptance is
  still required after installing the committed build.
- Claude Gateway files remain isolated operational credentials and are not copied by this source
  fix. The intended gateway must be provisioned into the Worker's private Provider Home.

## Final verdict

PASS for source validation. Commit/push, Worker replacement, and both live provider probes remain
deployment gates.
