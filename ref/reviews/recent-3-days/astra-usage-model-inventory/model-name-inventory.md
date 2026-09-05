# Model names and routing inventory

Date: 2026-09-04. Agent Deck baseline: `365dabc0eab9f328ac9fc0cbd6938ecef4ca5a7d`.
Skill Market checkout: `../skill-market`, baseline `eca6a1c99fcebc9903df2104942a3af20392e976`.

The user authorized two reviewer default updates and Astra Data panel support. The model lists below are inspection results for the user's next decisions. They were not updated. Skill Market was read-only; no installed Skill/plugin copy was modified.

## Reviewer defaults updated in this delivery

| Asset | Before | After | Reasoning |
| --- | --- | --- | --- |
| `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml:3` | `gpt-5.6-sol` | `gpt-6-astra` | `model_reasoning_effort = "xhigh"`, unchanged |
| `resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md:6` | `grok-4.5` | `grok-4.6` | `effort: high`, unchanged |

The Claude reviewer remains `opus` / `xhigh`. Only the two requested model values changed; role bodies, permissions, reasoning and delivery rules are byte-preserved. Existing app-owned bundled-Agent overrides and explicit spawn parameters retain their precedence over bundled defaults. This changes bundled defaults, not already-running sessions or user overrides.

## Agent Deck spawn/handoff model suggestions

| Location | Current contents | Runtime meaning |
| --- | --- | --- |
| `src/main/agent-deck-mcp/tools/schemas/target-runtime.ts:41` | Model description suggests `haiku`, `sonnet`, `opus`, `fable`; `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; `grok-4.5`. Astra and Grok 4.6 are absent. | This is the agent-visible model-field description. The field is trimmed free text, 1–256 characters, and explicitly says suggestions are not an allowlist. |
| `src/main/agent-deck-mcp/tools/schemas/spawn.ts:6` | `SPAWN_SESSION_MODEL_VALUES` repeats those eight values. | The spawn schema uses `MCP_TARGET_RUNTIME_SUPERSET_SHAPE`; it does not use this array as a model enum. Direct usages of this exported list are currently in tests. |
| `src/main/agent-deck-mcp/tools/schemas/spawn.ts:89` | Spreads the shared runtime shape. | `spawn_session` exposes the shared description above. |
| `src/main/agent-deck-mcp/tools/schemas/lifecycle.ts:45` | Spreads the same shared runtime shape. | `hand_off_session` inherits the same model suggestion text. Editing that shared description affects both. |
| `src/main/agent-deck-mcp/tools/handlers/spawn-model-options.ts:35` | Trims and forwards an explicit model; validates thinking against the adapter separately. | No concrete-model allowlist. The native runtime remains responsible for model availability. |
| `src/hosts/server-core/mcp-spawn-schema.ts:57` | `Optional provider model override.` | Server Core uses nonempty bounded text, without enumerated model suggestions. |
| `src/hosts/server-core/mcp-handoff-schema.ts:35` | Reuses the Server Core spawn model field. | Also free text; no old model-name list to replace here. |
| `src/main/agent-deck-mcp/__tests__/tools.test.ts:806` | Asserts the eight-value array and suggestion prose, including absence of several older/bare ids. | These tests must track any later intentional suggestion/list update; they do not make the runtime a whitelist. |

Model precedence in the current Desktop spawn description is explicit model, resolved Agent model, same-adapter source session, then selected Gateway/native default. The requested reviewer-default update already works through that existing path without changing the suggestion list.

## Other concrete Grok defaults and catalogs

These values are separate from `reviewer-grok` and remain unchanged:

| Location | Current value and effect |
| --- | --- |
| `src/main/adapters/session-creation-defaults-core.ts:256` | Generic Grok creation fallback uses `grok-4.5` if native configuration has no model. |
| `src/renderer/hooks/useSessionCreationOptions.ts:339` | Renderer safe fallback for a Grok creation form is `grok-4.5`. |
| `src/hosts/server-core/session-create-catalog.ts:97` | Server Core fallback creation defaults include `grok-4.5`. |
| `src/hosts/provider-state/provider-session-projection.ts:281` | Provider-home projection falls back to `grok-4.5` when the source Grok model is absent. |
| `src/hosts/provider-session/shim-entrypoint.ts:126` | Generated broker-side Grok configuration hardcodes `model = "grok-4.5"` and display name `Grok 4.5`. |
| `src/hosts/provider-session/shim-entrypoint.ts:288` | The shim advertises `localModelIds: ['grok-4.5']`. `shim-inference-proxy.ts` serves this through local `GET /v1/models`; it is an actual model catalog, not MCP suggestion text. The list itself is not a POST model-authorization allowlist. |

`src/shared/model-normalize.ts` is token-statistics identity normalization, not a selectable-model catalog. It retains semantic suffixes such as Astra and the 5.6 model variants through its fallback. Model literals also occur in test fixtures, fake provider endpoints and historical records; those document scenario inputs/history rather than active defaults. Active README, deployment and wrapper/script sources yielded no additional concrete model-name list in the bounded search.

## Skill Market: all 45 Skill sources

The inspected checkout contains 15 standalone Skills and 30 plugin Skills. The only Skill bodies with concrete model-version recommendations are these three byte-identical files:

- `../skill-market/skills/claude/parallel-tasks/SKILL.md:74`
- `../skill-market/skills/codex/parallel-tasks/SKILL.md:74`
- `../skill-market/skills/grok/parallel-tasks/SKILL.md:74`

Each is version `0.0.11` in canonical `../skill-market/catalog/entries.json` (package ids `claude:standalone:parallel-tasks`, `codex:standalone:parallel-tasks`, and `grok:standalone:parallel-tasks`). Model examples are in the Skill bodies, not the catalog descriptions or generated `skills/INDEX.md`.

The common routing table is:

| Tier | Current reference target | Current task class |
| --- | --- | --- |
| T1 | `fable-5 xhigh` | Cross-module architecture, concurrency, security, deep debugging requiring design judgment |
| T2 | `gpt-5.6-sol xhigh` | Multi-file implementation, complex refactoring and long reasoning chains |
| T3 | `gpt-5.6-terra xhigh` | A single module with clear implementation/refactoring boundaries |
| T4 | `opus-4.8 xhigh` | Mechanical edits, batch search, documentation and boilerplate tests |

These are capability/effort references. The surrounding rules default to the lead's adapter family and map a cross-family reference to the closest same-family model. Review work has a T3 floor, or T1/T2 for decisions affecting architecture, security, concurrency, behavior or gates. There is no explicit Astra target, Grok 4.6 target, or concrete Grok equivalence table. Dispatch controls and proposed substitutions must be included in the Skill's approval envelope; the table itself is not an executable model registry.

Other related content, without concrete model-name lists:

- `complex-work-planning` has three adapter copies, also version `0.0.11`. Lines 18–20, 43 and 87 discuss minimizing model-owned work and planning provider/model/settings boundaries; they select no concrete model or tier table.
- `project-engineering-foundation/assets/templates/review.template.md:18–19` in all three adapter packages has placeholder fields for reviewer model/human, reasoning effort, tool path and timeout. No fixed model names are prescribed.
- `prompt-asset-improver` and `plantuml-diagrams` prescribe no concrete model names.
- The 30 bootstrap plugin Skills prescribe no model versions. Some Claude/Grok mutating Skills declare `disable-model-invocation: true`; that controls implicit invocation and is not model selection.

## Decisions left to the user

1. Which concrete examples, if any, should appear in the shared spawn/handoff model description and its separate example array?
2. Should the generic Grok defaults, provider-home projection and shim model catalog also move to 4.6, independently of the already-updated reviewer default?
3. Which targets or model-resolution policy should replace the parallel-tasks T1–T4 references in each adapter package?

No action on these three groups was taken. No public model availability, live provider acceptance or installed-cache freshness is claimed by this source inventory.
