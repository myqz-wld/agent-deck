---
review_id: 330
reviewed_at: 2026-10-15
baseline_commit: a7ff9c5acae0a89dbf666fca8252bce77ae05eb0
expired: false
---

# Native tool loading: measured requests and optimization opportunities

Subsequent source repairs and additional native assertions are recorded in
[REVIEW_332](REVIEW_332_tool-search-fallback-repairs.md). The investigation below describes the
pre-repair baseline; its fixture directory now also includes the repair observations.

## Scope and method

The owner asked whether Tool Search can be optimized after PLAN_95 was merged. This follow-up
inspects actual loading behavior rather than inferring it from an MCP catalog. No production code,
provider configuration, README, installed application, or running host was changed. This is a lead
investigation, not a paired review. The review-expiry helper again stopped in historical coverage
mapping; no previous review exempts the inspected paths.

```review-scope
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tool-definition.ts
src/main/agent-deck-mcp/server.ts
src/main/adapters/codex-cli/sdk-bridge/client-construction.ts
src/main/adapters/codex-cli/app-server/client-process-host.ts
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/claude-code/sdk-runtime-core.ts
src/main/adapters/claude-code/sdk-bridge/query-options-builder-core.ts
src/shared/session-component-refresh.ts
```

Disposable native runtimes used the installed Codex 0.162.1 and Claude SDK 0.3.299. Their inference
and MCP endpoints were loopback-only fake servers. The MCP fixture served the current real 20-tool
catalog without invoking application handlers; fake inference responses requested one discovery
operation and then completed. Isolated provider configuration roots and synthetic authentication
were used. No real model endpoint was queried, and no live Agent Deck session was used as a probe.

## Findings

| Severity | Finding | Evidence and proposed correction |
| --- | --- | --- |
| MEDIUM | Codex custom model aliases can fall back to metadata that disables native search. | Known `gpt-6-sol` deferred all 20 definitions; unknown `fixture-model` sent all 20. Correct verified model metadata rather than restoring retired switches or pretending every alias supports search. |
| MEDIUM | A configured Codex model catalog can be passed at the wrong lifecycle boundary. | Native `model_catalog_json` is startup-only. The same fixture alias stayed eager when supplied through `thread/start.config`, then became deferred when supplied before app-server startup. Agent Deck currently constructs per-session app-server without startup config and applies Gateway overrides in thread configuration. Carry explicitly configured, owning-host model metadata through process startup. |
| MEDIUM | Claude disables search by default for non-first-party base URLs. | The loopback Gateway fixture sent all 20 MCP definitions by default. `ENABLE_TOOL_SEARCH=true` exposed ToolSearch and deferred the definitions; one semantic search loaded exactly `list_sessions` with a `tool_reference` response. Enable only for a verified-compatible Gateway or explicit user selection; preserve deliberate opt-outs. |
| MEDIUM | Grok search results truncate long descriptions before the model sees them. | Local source caps descriptions at 2,048 characters. Current `spawn_session` (5,110), `hand_off_session` (3,058), and `enter_worktree` (2,742) exceed it. Review their complete contracts for lossless shortening and preservation of critical lifecycle/failure rules. Do not silently drop those rules or add another search gateway. |

## Captured request results

| Runtime / fixture condition | First request: full Agent Deck MCP definitions | After one discovery |
| --- | --- | --- |
| Codex, known model | 0 | Only `list_sessions` description/contract appears |
| Codex, unknown alias | 20; MCP namespace serializes to 44,807 characters | Eager fallback, no discovery required |
| Codex, alias plus catalog in thread config | 20 | Same eager fallback |
| Codex, alias plus catalog at process startup | 0 | Only `list_sessions` description/contract appears |
| Claude, non-first-party base URL, search unset | 20; MCP definitions serialize to 67,837 characters | Eager fallback |
| Claude, same endpoint with search explicitly enabled | 0, with ToolSearch and deferred names available | One MCP definition with `defer_loading:true` and a `tool_reference` result |

Codex carries tool specifications in `input[].type=additional_tools` in this runtime; inspecting
only the top-level `tools` key would give a false zero. Both locations were inspected. Its known-model
fixture uses native Code Mode discovery through `functions.exec` and `ALL_TOOLS`; this is evidence of
native deferral and selective loading, not a measured autonomous BM25/model search success rate.
The alias catalog copied supported model metadata only within the controlled fake endpoint. It is
not evidence that an arbitrary real provider or alias supports those features.

The character counts are provider-specific serialized definition regions, not tokens, total prompt
savings, latency, cache hits, or billing reductions. Removing most of these regions from the initial
request creates a concrete opportunity on the eager paths. Healthy deferred paths already avoid
that cost, so they may gain almost nothing from changing loading policy. Discovery has its own entry,
name-list and result overhead, and discovered definitions can remain in subsequent context.

The full public MCP wire catalog is 101,335 serialized characters, including output schemas. The
input-contract projection is 68,458 characters. These differ from earlier planning estimates and
must not replace the actual native-request measurements above or be treated as interchangeable.

## Native source and documentation

Local Codex source baseline: `4fd5745e8486d655a0c7e7d762741465b986130b`, under `$CODEX_SOURCE`:

- `codex-rs/core/src/mcp_tool_exposure.rs` selects deferred exposure when search is available.
- `codex-rs/core/src/tools/spec_plan.rs` checks model search capability and provider namespace support.
- `codex-rs/models-manager/src/model_info.rs` sets `supports_search_tool:false` for unknown model metadata.
- `codex-rs/features/src/lib.rs` marks old `tool_search` / `tool_search_always_defer_mcp_tools` flags as no-ops.
- `codex-rs/core/config.schema.json` documents `model_catalog_json` as startup-only, with per-thread overrides accepted but ineffective. Installed-native fixtures confirmed that boundary.

Local Grok source baseline: `f049847ce9426ee3e33b452cd340f2ef6b900edb`, under `$GROK_SOURCE`:

- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/sampler_turn.rs` builds the local sampling toolset from built-ins only, with native search always enabled in this source.
- `crates/codegen/xai-grok-tools/src/registry/types.rs` omits MCP-qualified names from that set.
- `crates/codegen/xai-grok-tools/src/implementations/search_tool/mod.rs` returns matched schemas and truncates descriptions; default result limit is five.
- `crates/codegen/xai-grok-shell/src/session/tool_definitions_artifact.rs` defines a native sampled-tool artifact that could support future diagnostics without another model call. Do not substitute disk asset presence for such native evidence.

The installed Grok dependency is 1.0.52; it was not invoked for this follow-up. Grok conclusions here
are source-backed, unlike the captured installed Codex/Claude request shapes.

Official [Claude SDK Tool Search documentation](https://code.claude.com/docs/en/agent-sdk/tool-search)
confirms non-first-party Gateway defaults, explicit overrides, and the need for compatible
`tool_reference` handling. The fake endpoint proves what the SDK sends, not that a user's real Gateway
accepts it. Official [Grok settings](https://docs.x.ai/build/settings/reference) describe native search;
local source is the more specific evidence for the inspected sampling path.

## Validation and reproducibility

Sanitized observations: [observations.json](REVIEW_330_tool-search-loading-evidence/observations.json).
Portable fixture source is retained beside this record. From the repository root, run:

```sh
pnpm run test --config ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/vitest.config.ts
node ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/codex-probe.cjs gpt-6-sol
node ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/codex-probe.cjs fixture-model
node ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/claude-probe.cjs default
node ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/claude-probe.cjs true
```

For the catalog-boundary comparison, use `fixture-model catalog-startup <public-models-json>` and
`fixture-model catalog-thread <public-models-json>` with the Codex fixture. The input is the public
Codex `codex-rs/models-manager/models.json` file, not private provider configuration. Fixtures use
local temporary files; raw request captures may contain locally discovered skill paths, so they
remain private and must not be committed or shared. The fixtures target macOS arm64 for the native
Codex binary used in this investigation.

The catalog fixture passed. An initial test-config merge also included the existing suite:
1,182 files / 7,418 tests passed, with 3 files / 6 tests skipped. The retained config selects only the
one fixture. No application code change required another application build. SQLite binding SHA-256
remained `463d208825f4d2660f4ec14181563c4b2ddbfeb779584c9b3251f0d7aafb2c67`.

## Fixes landed, residual risk, and next work

No production fix is included in this investigation. Recommended order:

1. Fix startup delivery of explicitly configured Codex model catalogs, with native fake-endpoint
   regression coverage for known/unknown aliases and remote owning-host paths.
2. Add truthful per-Gateway Claude search configuration/compatibility handling. Never silently
   override an explicit disable or claim a fake server validates a real Gateway.
3. Shorten redundant tool-description wording without dropping contracts, and test the Grok search
   result boundary plus representative discovery queries before changing prompt assets.
4. Expose configured, available, deferred, and observed-loading evidence separately. Keep real token
   and cache savings unknown until an authorized real-provider measurement exists.

README remains unchanged and concise. No package installation, host restart, deployment, live model
call, application settings edit, or provider-source modification was performed.
