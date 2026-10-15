---
review_id: 332
reviewed_at: 2026-10-15
baseline_commit: a7ff9c5acae0a89dbf666fca8252bce77ae05eb0
expired: false
---

# Native Tool Search fallback repairs

## Scope

Lead implementation audit following [REVIEW_330](REVIEW_330_tool-search-loading-evidence.md),
with sequential work in an Agent Deck isolated worktree. The user approved the repairs and chose
existing Claude Gateway JSON configuration instead of a new UI switch. No paired review, live
application change, private configuration edit, or paid model call was performed. The expiry
helper stopped while mapping historical coverage; all changed source boundaries were audited
without treating earlier reviews as exemptions.

```review-scope
src/main/adapters/codex-cli/app-server/model-catalog.ts
src/main/adapters/codex-cli/app-server/model-catalog.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/client-host-port.ts
src/main/adapters/codex-cli/app-server/client-process-host.ts
src/main/adapters/codex-cli/app-server/client-process-host.test.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/thread-mode.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction.test.ts
src/main/adapters/codex-cli/sdk-bridge/client-registry.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host-core.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-model-catalog.test.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.test.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-codex-catalog.test.ts
src/main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings-core.test.ts
README.md
```

## Findings and fixes

| Severity | Finding | Resolution |
| --- | --- | --- |
| MEDIUM | Codex silently ignored selected model catalogs passed only through thread config. | Carry the effective explicit catalog through new/resume/fork client construction into native process argv. Agent configuration overrides the Gateway layer. Only this startup-only field is promoted. |
| MEDIUM | A hot Gateway change could report success while retaining an older process catalog. | Reject catalog changes before staging options. Cached create/resume rejection happens before token allocation, preventing rollback from disposing an existing runtime. No process is replaced to apply metadata. |
| INFO | Claude non-first-party endpoints need explicit compatible Tool Search opt-in. | Verified the existing Gateway JSON path and production sandbox-derived settings path with installed native SDK. Both honor true/false; no redundant application policy or new setting is necessary. |

Desktop and Server Core pass a literal TOML string through argv, without shell evaluation. Server
Core retains its trusted permission, MCP, hook and plugin startup controls and its owning-host
environment. No catalog is read from the Desktop as a substitute for a remote host. Explicit
overrides require an absolute path on the runtime host; empty, relative, home-relative and invalid
values fail with an actionable error. Native config.toml defaults are unchanged when no override
is supplied. Native Codex validates catalog contents and model capabilities.

The shared tool definitions, descriptions, schemas, permission behavior, native feature flags,
and Claude/Codex/Grok prompt assets remain unchanged. README adds three lines of usage guidance.

## Validation and native evidence

- `pnpm typecheck`: passed, including architecture and Node boundary checks.
- `pnpm test`: 1,184 files / 7,443 tests passed; 3 opt-in files / 6 tests skipped.
- `pnpm build`: passed. Installed application and running provider sessions were untouched.
- Targeted tests cover config precedence, literal argv escaping, invalid paths, new/resume/fork,
  cached-client token/process preservation, staged changes, and Server Core startup boundaries.
- The separate catalog fixture also passed; the original 20-tool contract remains intact. SQLite binding SHA-256 before and after:
  `463d208825f4d2660f4ec14181563c4b2ddbfeb779584c9b3251f0d7aafb2c67`.
- No modified production source exceeds 500 lines.

| Installed native fixture | Initial full MCP definitions | After scripted discovery |
| --- | --- | --- |
| Codex 0.162.1 unknown alias, catalog supplied through startup argv | 0 | Only list_sessions |
| Claude SDK 0.3.299, Gateway settings env true, sandbox off | 0 | 1 |
| Claude SDK 0.3.299, production-derived sandbox settings, env true | 0 | 1 |
| Claude Gateway env false, either sandbox path | 20 | No discovery requested |
| Claude Gateway env auto:5 on the fake third-party endpoint | 20 | No discovery requested |

The Codex fixture checks both top-level tools and additional_tools input entries. The Claude
fixture checks native ToolSearch and the selectively loaded definition. Native inference and MCP
endpoints are synthetic loopback servers; discovery requests are scripted. This verifies delivery
and loading, not autonomous search quality, a real Gateway's compatibility, or savings in tokens,
cache charges, latency or cost. Healthy paths already using native deferral gain no new loading
policy savings.

Sanitized results: [repair observations](REVIEW_330_tool-search-loading-evidence/repair-observations.json).
Reusable fixtures remain beside the earlier evidence. `codex-probe.cjs` adds `catalog-argv` with a
public native models.json input. `claude-probe.cjs` adds settings-true/settings-false/settings-auto:5
and derived-true/derived-false. Derived modes compile the current production
`src/main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings-core.ts` into their
private temporary directory using the existing Vite esbuild dependency. No fixture executes by
default in the ordinary test suite. Raw requests remain private.

## Residual risk and activation

Unrecognized aliases still need truthful, compatible native model metadata; the application does
not invent it. A changed catalog file or selected catalog requires a new provider instance, and
`/deck-refresh` cannot apply it to an existing process. Claude opt-in does not prove an actual
Gateway supports the required protocol. Operators must configure compatible Gateways explicitly.
The new Codex source must be included in an updated application/runtime before new sessions use it.
No restart or installation was performed.

Grok source already defers MCP definitions. Lossless long-description editing and new observed
activation UI are separate follow-ups, outside this eager-fallback repair. Live Grok activation
and real input/cache-token savings remain unmeasured.
