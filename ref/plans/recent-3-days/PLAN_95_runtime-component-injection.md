---
plan_id: 95
created_at: 2026-10-15
completed_at: 2026-10-15
status: completed
baseline_commit: c700f88b25f28106197e5c483a035405a46d4e14
---

# Runtime Component Injection Optimization

## Status

- Created: 2026-10-15.
- Baseline: `c700f88b25f28106197e5c483a035405a46d4e14`.
- State: T0-T6 source implementation and required validation complete in the approved isolated worktree.
- Goal: optimize bundled component injection for Claude Code, Codex CLI, and Grok Build, while preserving session continuity and native tool discovery.
- Source is validated. Installed application, shared dependencies, and live processes remain untouched.
- Integration: the owner authorized committing, merging to main, worktree/branch cleanup, and pushing after source validation. Runtime activation remains outside this authorization.

## Confirmed scope and invariants

- The user requested all previously proposed injection optimizations and an explanation of explicit idle-boundary refresh.
- Ordinary bundled-component toggles retain the established new-session-only meaning.
- A session must retain readable assets for its selected version throughout its lifetime.
- Keep each provider's native MCP, plugin, skill, permission, and authentication ownership.
- No secrets or machine-specific paths in repository records or distributable artifacts.
- No changes to live Agent Deck processes or installed applications without exact authorization.
- Preserve all MCP descriptions, schemas, authorization, and output contracts during registry decoupling.
- Respect provider-managed settings and user/project components. Do not write global provider configuration to activate bundled components.
- Use deterministic code for manifests, hashing, resource publication, gates, validation, and status aggregation. No new model calls are needed.
- The user additionally requested fixing the header Pending navigation button's vertical alignment, illustrated by a screenshot. Include this bounded renderer fix in the implementation scope.

## Decision ledger

| ID | Decision | Owner | Status | Evidence / proposed answer |
| --- | --- | --- | --- | --- |
| D1 | Optimize the three adapters and shared injection infrastructure | User | Confirmed | User requested all proposed optimizations. |
| D2 | Use the complex-work-planning workflow or proceed directly | User | Confirmed | User selected the planning workflow in the first question group. |
| D3 | Refresh only natively reloadable components, or rebuild sessions for complete refresh | User | Confirmed | User selected native-only refresh; unsupported/frozen components require a new session. |
| D4 | Default setting changes affect new sessions | User / existing contract | Confirmed | Existing UI contract and requested preservation. |
| D5 | Busy refresh waits for a safe provider boundary | User | Confirmed | Included in the selected refresh-scope answer. |
| D6 | Keep provider tool search native and capability-aware | Engineering | Selected | Codex and Grok already implement discovery; avoid inventing another search protocol. |
| D7 | Use immutable asset snapshots with content fingerprints | Engineering | Selected | Prevent shared mirror deletion/replacement from changing existing sessions; retention follows existing application history ownership. |
| D8 | Native plugin reload can rescan user/project components | User | Confirmed | User selected native rescan, with scope disclosure and cache-impact holds that preserve the prior state. |
| D9 | Refresh entry placement | User | Confirmed | User requested slash-command support instead of a dedicated button or menu item. Use existing slash completion. Proposed engineering names: `/deck-refresh` and `/deck-refresh cancel`. |
| D10 | Header Pending button alignment | User | Confirmed | User supplied a screenshot and requested the height/alignment fix after approving the main plan. |
| D11 | Grok refresh verification | User request / engineering evidence | Constrained | User asked whether success can be verified. Distinguish files prepared, native session load acknowledged, and unverified effective runtime state. Disk inspection/connectivity alone never proves live hot reload. |
| D12 | Tool Search implementation and savings | User request / measurement | Constrained | Reuse native discovery, compare the existing runtime baseline against the changed implementation, and distinguish catalog-size potential from observed net prompt/token savings. |

The choices and tradeoffs were presented in two native question groups. D2's selected route adds durable planning and isolated implementation; direct implementation was the alternative. D3 preserves native-only refresh and reports unsupported components; full session reconstruction was the larger alternative. D8 allows the native scan scope while preserving provider configuration files; strict bundled-only scope would skip any non-isolatable native reload. For D9, the user rejected a new button and proposed slash commands after being offered existing-menu and save-time-scope options. The command spelling is an engineering detail within that selected UI route.

### Checkpoints

- A: passed. Scope, native-only refresh, new-session defaults, busy-boundary behavior, native scan scope, and slash entry route are resolved.
- B: passed. Source investigation exposed fixed Claude plugin roots, Core store sharing, resumed-history retention, and native rescan scope; these are addressed in the design without changing permissions or rebuilding live sessions.
- C: passed for the assembled plan. No material user-owned decision remains unresolved. Unsupported runtime methods, cache holds, and partial outcomes are explicitly represented rather than hidden behind a new fallback.
- Final assembled-plan approval: approved after clarifying `/deck-refresh cancel`. It withdraws only a queued extension-refresh reservation; it does not stop the running agent or cancel ordinary queued user messages. The later screenshot fix is separately authorized by the user's direct request; no renewed approval is needed for that bounded addition.

## Pre-implementation evidence

### Shared MCP registry

- `src/main/agent-deck-mcp/tools/index.ts` imports `loadSdk()` and invokes Anthropic's `tool()` even for HTTP consumers.
- `src/main/agent-deck-mcp/server.ts` already registers description, input/output schemas, annotations, metadata, and handlers with the MCP SDK.
- Source registry has 20 tools and approximately 19,934 description characters. This is catalog size, not measured per-turn model context usage.
- `src/main/agent-deck-mcp/tool-policy.ts` only needs a tool-name shape, but currently imports an Anthropic tool type.

### Asset lifecycle

- `src/main/codex-config/skills-installer.ts` removes the shared mirror when skills are disabled.
- `src/renderer/components/assets/InjectionToggleBar.tsx` promises running sessions are unaffected by setting changes.
- `src/main/adapters/claude-code/plugin-mirror-store.ts` caches path/flag signatures and replaces one shared destination.
- `src/main/adapters/grok-build/resource-store.ts` caches skill/agent combinations and rebuilds each target with remove/copy operations.
- `src/main/codex-config/skills-mirror-manifest.ts` already provides deterministic content hashing and tree validation worth reusing.
- `src/hosts/server-core/node-asset-catalog.ts` uses all three stores. Any shared storage change must preserve Desktop, Relay Worker, and Server Core contracts.

### Claude

- Current dependency is `@anthropic-ai/claude-agent-sdk` 0.3.299; latest checked is 0.3.300.
- Current SDK exposes `setMcpServers`, `toggleMcpServer`, `reconnectMcpServer`, `mcpServerStatus`, `reloadSkills`, and `reloadPlugins`.
- `reloadPlugins({ holdOnCacheImpact: true })` may return `held` and a cache-impact description; older runtimes may omit the field.
- `setMcpServers` replaces the dynamic SDK-managed set, but plugin-owned MCP servers are retained unless explicitly replaced. Do not equate an empty payload with zero session tools.
- Plugin reload has no parameter for replacing the initial plugin directory list. Refreshing an immutable snapshot requires a session-owned stable view or an explicit unsupported result.
- `InternalSession` includes foreground-turn, compaction, background-task, pending-permission/question, submitted-input, retirement, and cwd-transition state. An idle indicator alone is insufficient for refresh safety.

### Codex

- Current dependency is `@openai/codex` 0.162.1.
- Existing app-server setup uses `developerInstructions`, ephemeral MCP configuration, and process-scoped `skills/extraRoots/set`.
- Native `skills/list`, `skills/changed`, and thread-scoped `mcpServerStatus/list` can support effective-state diagnostics.
- `config/mcpServer/reload` reloads disk configuration; it is not proof of support for replacing an injected per-thread MCP override.
- Installed binary contains native deferred-tool search. Old `tool_search` feature switches are removed; do not add them back.
- Model/provider-specific activation needs controlled verification, not inference from catalog size or binary strings alone.

### Grok

- Current dependency is `@xai-official/grok` 1.0.52, using ACP SDK 1.8.0.
- `session-setup.ts` supplies MCP configuration and `_meta.rules` / `_meta.pluginDirs` on new/load.
- Loading a native session retains its persisted system prompt.
- Official configuration documents native MCP tool search enabled by default through `GROK_TOOL_SEARCH` / `[features].tool_search`.
- Planning initially had no verified ACP hot-reload contract. The source correction below supersedes that limitation for session-scoped MCP only; TUI commands are not used as evidence.
- Grok reads compatibility assets from Claude and `$HOME/.agents`; diagnostics should identify the effective source and same-name collisions.
- `grok inspect` can establish disk/config discovery and `grok mcp doctor` connectivity, but neither proves an existing ACP session has refreshed. `available_commands_update` can corroborate its command catalog only, not all MCP tools or prompt content. Without an explicit native reload acknowledgment and matching effective inventory/version evidence, show new-session-required or unverified rather than success. No live model turn is authorized solely to fabricate a success probe.

### Slash-command integration

- `src/shared/session-commands.ts` provides bounded normalization, merging, matching, and exact command invocation helpers.
- `src/renderer/components/SessionDetail/composer-sdk/SlashCommandMenu.tsx` already renders completion candidates in the composer.
- `src/main/ipc/adapters-outgoing.ts` currently sends ordinary messages through handoff redirection. Application refresh commands need an explicit typed action route so a stale caller cannot silently refresh a successor.
- `src/hosts/server-core/runtime-session-extras.ts` and `src/contracts/methods.ts` are the corresponding remote command/catalog and method boundaries. User-facing host-local commands must not be forwarded to the LLM as text.

### Added header alignment fix

- `src/renderer/components/AppHeader.tsx` owns both the left Pending count chip and the right Pending navigation tab shown in the screenshot.
- Navigation `TabButton` already declares `h-5`, but its text has inherited line height and its badge adds vertical padding without a bounded line height. Inspect both Pending presentations and normalize the relevant button/badge alignment with existing adjacent controls.
- This is a small renderer-only change. Prefer visual verification and existing relevant checks; do not add tests that merely assert a chosen CSS class.

## Proposed implementation tracks

1. Provider-neutral shared MCP definitions, preserving public contracts and parity tests.
2. Immutable, validated bundled asset snapshots plus per-session ownership and safe retention; no immediate deletion when a toggle changes.
3. Explicit refresh state machine integrated with provider input boundaries, conditional on D3.
4. Native reload adapters and truthful per-component results; unsupported and failed components retain their prior state where provable.
5. Effective-component diagnostics and native tool-search verification; no unsupported feature flags.
6. Chinese UI action/status, typed IPC/preload and remote runtime routing where supported.
7. Relevant documentation, tests, build, and final records.

## Concrete design

### Shared definition boundary

Define an SDK-neutral tool record with name, description, Zod input/output schemas, annotations, metadata, and handler. Desktop in-process and HTTP transports consume that record; the Claude adapter retains only the SDK server-instance wrapper. Core already uses MCP SDK registration directly, so preserve its host-specific handlers and maintain shared contract parity rather than merging unrelated host services.

### Asset snapshots and ownership

- Build a canonical manifest over the transformed effective tree, component inclusion flags, and manifest format. Publish into a digest-addressed application-owned directory through staging and rename.
- Persist the application's session-to-snapshot references, including versions needed by resumable history; session close alone does not release historical references. Follow the existing session deletion/retention boundary for collection, and preserve unknown legacy references conservatively.
- Resolve source paths on the owning host. Desktop, Relay Worker, and Server Core must not substitute local renderer paths for remote paths.
- New sessions select the current snapshot. Existing sessions retain their selection unless an explicit native refresh succeeds.
- Claude's fixed startup plugin-root list may require a session-owned stable plugin view for native reload. Do not mutate a view while any relevant foreground or native background consumer is running. If no app plugin root was loaded initially and no verified native add-root method exists, report new-session-required instead of silently adding a placeholder plugin to every disabled session.
- Keep source content browsing separate from runtime-selected versions. Turning injection off must not hide the bundled asset from the library.

### Explicit refresh state machine

States: idle, queued, applying, completed, partial, failed, and cancelled. A generation-scoped operation records the user's requested settings revision and selected target session. Repeated requests coalesce to the latest explicit request rather than creating parallel refreshes. `/deck-refresh cancel` cancels a queued request; it does not interrupt native mutation once applying.

The adapter owns the safe input boundary. It must atomically reserve the gate before the idle check, allow current work and necessary permission replies to finish, hold the next ordinary input, and release it exactly once. Do not reuse worktree transition identity for unrelated refreshes, and do not block the permission response needed to reach idle.

Close, handoff, cwd transition, provider replacement, or loss of runtime identity cancels the refresh. A queued operation never migrates automatically to a successor. Pending refresh is runtime state, so an application restart does not replay a previously queued mutation without a live explicit request.

Prepare candidate assets first. Apply only verified native APIs, validate returned effective state, and record per-component outcomes. Keep old references until the new state is observed. On a partial native failure, reconcile the observed state and show the precise result; do not assert a global rollback merely because the host reverted its own fields.

### Provider capability matrix

| Component | Claude | Codex | Grok |
| --- | --- | --- | --- |
| App-owned MCP add/remove/reconnect | Native SDK APIs; preserve the complete SDK-owned set and plugin ownership | New-session-required for injected overrides unless a supported replacement method is proven | Native session-scoped replacement with acknowledgment and inventory verification; fallback when unsupported |
| Bundled Skills | Reload at a safe boundary when an eligible plugin root is already present | Replace extra roots, including an empty set, then force a skill catalog refresh | New-session-required: native reload broadcasts beyond the target session |
| Loaded plugins/agents | Native reload subject to approved scan scope and cache-impact hold | Preserve current resolver/start-time semantics | New-session-required |
| Application baseline prompt | New-session-required in this scope | New-session-required in this scope | New-session-required |
| Discovery diagnostics | Fresh MCP status and refreshed component lists | Thread-owned MCP status and skill list | Current negotiated/catalog evidence; mark unknown fields explicitly |

Missing methods and unknown outcomes are explicit limitations, not reasons to restart a provider process automatically. Detect capabilities where advertised; use bounded unsupported-method handling where no capability name exists. Do not mistake a TypeScript method's presence for CLI support.

### Native discovery and performance

Preserve native Tool Search defaults and explicit user/provider settings. Do not inject retired Codex flags or force Claude tool references through an unverified Gateway. Track observed discovery behavior separately from a provider's configured/default capability. Use read-only diagnostics on request and existing lifecycle events, avoiding new per-turn catalog polling. Keep full effective tool contracts available at discovery time.

The SDK-neutral registry removes an unnecessary Anthropic runtime dependency from non-Claude MCP construction. Assess the Claude `/core` entry point against the actual imported export set before adopting it. Dependency updates are limited to the checked compatible Claude patch if validation supports it; no model migration or global runtime changes are part of this work.

The user asked for the implementation approach and expected prompt savings. Current-session readable metadata for 20 Agent Deck tools totals 52,906 characters, including descriptions and input/output declarations. A 4-character-per-token heuristic gives about 13,200 tokens, not a native request/tokenizer measurement. The metadata for `list_sessions`, `get_session`, and `send_message` totals 7,266 characters (about 86% smaller than the full catalog, before search/index overhead). These are conditional catalog-size comparisons, not measured total-prompt savings or net savings from this change. Native discovery may already be active; report near-zero incremental savings if that is the observed result. Compare input/cache tokens, exposed definition size, discovery success, and first-tool latency where the provider supplies reliable evidence. Do not introduce real model calls automatically just to obtain favorable numbers.

## Sequential task breakdown

All tasks are currently lead-owned and sequential; no delegation or paired reviewer selection has been requested.

T1 task record: `ref/plans/recent-3-days/PLAN_95_runtime-component-injection/tasks/t1-provider-neutral-mcp.md`. Final approval and isolation preceded execution; the task is complete. Create similarly bounded records for later complex implementation tracks before delegation or a cold handoff to those tracks.

| Task | Scope | Dependencies | Done criteria |
| --- | --- | --- | --- |
| T0 | Header Pending button alignment in `src/renderer/components/AppHeader.tsx` and its existing navigation components | Isolation | Pending with/without badge and active/inactive states aligns with adjacent tabs; no new permanent controls; appropriate existing checks pass |
| T1 | Provider-neutral tool definition and policy types in `src/main/agent-deck-mcp/`; focused shared-contract tests | Confirmed final plan | No runtime Claude import when building generic MCP tools; published schemas, descriptions, annotations, names, and handler behavior unchanged |
| T2 | Shared snapshot infrastructure, three resource stores and Desktop/Core call sites, durable ownership/retention integration | T1 | Old session paths survive toggles and updates; new sessions receive new hashes; crash/rename/delete/resume cases covered |
| T3 | Shared refresh contract and provider-owned input gates in adapter/runtime lifecycle modules | T2 | Idle, busy, background task, pending approval, close/handoff/cwd/reconnect races have deterministic outcomes |
| T4 | Native refresh and effective-state diagnostics with provider-specific boundaries | T3 | Per-component status matches observed native results; no automatic provider restart; cache-impact holds and partial failures tested |
| T5 | Application-owned slash command, existing completion UI, typed IPC/preload and Core/Relay routing, Chinese feedback | T4, D8, D9 | `/deck-refresh` and its queued cancellation execute locally without a model turn; remote actions stay on the selected host |
| T6 | Native discovery diagnostics, SDK load-path evaluation, docs, required validation, final records | T1-T5 | Required checks pass; performance claims only where measured; live application remains untouched |

Every structural change must stay within the file-size guardrail or carry the repository-required concrete residual-risk record. Splitting producer/consumer contracts into concurrent work is excluded from this plan.

## Blindspot and plan challenge results

The review-expiry helper was executed before the planning challenge. It exited 1 with no stderr after producing 5,720 lines and 445 missing-baseline markers. No prior review coverage is used to exempt any changed file; implementation must review its complete changed scope.

- UI idle is not provider idle: Claude native background tasks and pending control requests can outlive the main response. Gate on provider-owned state and fail closed when state is unknown.
- Resumable history outlives live runtimes: do not collect snapshots using live reference counts alone.
- Native plugin reload is broader than an app-owned directory: D8 allows the native rescan with explicit scope and cache-impact handling.
- Claude plugin lists are fixed at startup: do not claim an empty initial plugin list can acquire a new root through `reloadPlugins`.
- Codex extra roots are process-scoped: update only the session-owned live client, not a shared oneshot pool.
- MCP replacement does not own plugin-managed servers: retain ownership and permissions, and do not use an empty dynamic set as a universal removal command.
- Native tool-search support is not observed activation: diagnostic output must distinguish supported/default/configured/observed/unknown.
- Cache-impact holds must leave runtime state and the session's selected asset view coherent.
- Remote diagnostics must preserve host boundaries and omit tokens, credential/config payloads, and identifying path data from retained logs.

## Refresh design constraints to resolve

- A queued request must identify the application session and current runtime generation.
- Coalesce repeated requests for the same session; never refresh a successor or replacement accidentally.
- Reserve the provider input boundary before refreshing so a queued user message cannot start between the idle check and the mutation.
- Wait for active foreground work, native background consumers, compaction, tool requests, and approvals as required by that provider.
- Worktree transitions, handoff, close, reconnect, and model/runtime mutations must have a deterministic precedence and cancellation policy.
- Keep existing queued user input in order and resume it exactly once after refresh.
- Report each component independently: applied, unchanged, deferred, unsupported/new-session-required, or failed with a recoverable next action.
- Native operations are not a single transaction; verify observed state before claiming rollback or success.
- Do not force plugin reload after a cache-impact hold without the chosen user-facing policy.
- Persisted transcripts may refer to asset paths after runtime disposal. Retention must account for resumable sessions, not only live reference counts.

## Validation strategy

- Deterministic tests for stable hashes, snapshot reuse, content changes, disabled injection, failures, and readable old-session paths.
- Assert shared tool names, descriptions, input/output schemas, annotations, and behavior remain unchanged after decoupling.
- Provider mocks for idle/busy refresh, repeated clicks, new input races, close/handoff/worktree/reconnect cancellation, background tasks, plugin holds, partial failures, and unsupported methods.
- Typed IPC/preload/renderer and remote-host tests for exact session targeting and truthful status.
- Native tool-search verification only through isolated fake MCP/provider fixtures or separately authorized live experiments. No automatic real provider calls.
- Required repository checks: `pnpm typecheck`, `pnpm test`, `pnpm build`; preserve the Electron SQLite binding.
- Final records and README follow repository English documentation and Chinese UI-copy rules.
- Runtime activation is separate from source validation; no restart or install is authorized.

## Coordination and cold start

- Planning and isolated handoff are complete. See the execution log for the authoritative implementation state.
- The user approved this plan, isolated execution, and same-adapter implementation handoff. Do not restart planning or ask again for the confirmed decisions.
- Agent Deck task: `6328d5b4-1e1f-4514-8d69-1998fd6ec5d4`. Source implementation is complete; the task also tracks the subsequently authorized Git integration and cleanup.
- Isolation is active at repository-relative identity `.agent-deck/worktrees/<isolated-worktree>`, detached from `c700f88b25f28106197e5c483a035405a46d4e14`. Agent Deck owns the structured worktree lease. Preserve it across handoff.
- The transfer manifest SHA-256 values were verified before restoring the plan/task. The archived plan and task below are now authoritative; temporary transfer copies are removed after verification.
- Authoritative plan: `ref/plans/recent-3-days/PLAN_95_runtime-component-injection.md`. First complex task record: `ref/plans/recent-3-days/PLAN_95_runtime-component-injection/tasks/t1-provider-neutral-mcp.md`.
- Handoff entry actions were completed: repository instructions read, T0 implemented first, T1 accepted, then T2-T6 executed sequentially.
- At handoff, only archived planning records and dated-plan moves were present. The current worktree also contains the implementation and validation records; dependencies remain unchanged.
- No agents were delegated work. Execute sequentially; a handoff is not permission to spawn parallel agents.
- No live application restart, install, deployment, or real model probe is authorized. Source validation is authorized; use deterministic fixtures and protect the existing Electron SQLite binding.
- When the implementation eventually creates commits, inspect author/committer identity first. Before exiting the leased worktree, ensure its HEAD is referenced and use the Agent Deck exit workflow.

## Slash-command interaction

- `/deck-refresh` appears in the existing `/` autocomplete for supported Agent Deck-owned sessions. It is an application command, not a model prompt or a provider-native slash command.
- Intercept only an exact standalone command and documented arguments. Text merely mentioning the command, code blocks, unknown arguments, and an attached-file message must not silently lose user content. Invalid invocation returns clear Chinese usage without invoking the model or applying changes.
- Route and authorize the command at the host boundary as well as the UI. The remote session owner handles remote requests; the renderer cannot choose local fallback behavior.
- Use a typed user action for execution. Ordinary cross-session MCP messages, assistant output, provider tool results, and quoted slash text must not acquire host-command authority merely by containing `/deck-refresh`.
- Completion should distinguish application commands from provider commands and resolve naming conflicts deterministically.
- An idle invocation refreshes eligible changed components. A busy invocation reports queued status, then the eventual per-component result. An unchanged invocation is a no-op with feedback.
- `/deck-refresh cancel` cancels only a pending request. During applying, report that the operation is finishing and do not interrupt tool execution.
- User-facing cancellation copy must say “撤销排队中的扩展刷新”, not the ambiguous “取消请求”. Example: request refresh while an agent is working, then withdraw that reservation to continue using the old extension version; the agent's task and normal message queue continue unchanged. Cancellation is optional and is unnecessary during ordinary use.
- Use existing conversation/system feedback presentation. Do not add a permanent toolbar button or open a new settings dialog.
- Keep model transcript and usage accounting free of synthetic user prompts for this local operation. Any retained UI operation record is explicitly an application action.

## Official evidence checked during planning

- Claude MCP/tool search: https://code.claude.com/docs/en/agent-sdk/tool-search
- Claude patch release: https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.300
- Codex app-server: https://developers.openai.com/codex/app-server
- Grok native discovery settings: https://docs.x.ai/build/settings/reference

These sources and the installed SDK declarations informed the plan. Native runtime observations remain necessary before claiming a component refresh or net token saving.

## Execution log

- T0 complete: fixed button/badge height, line height, and left-side vertical centering. Browser inspected the actual rendered component in active/inactive and badge/empty states: all visible adjacent controls share 16.25 CSS-pixel height and identical top coordinates in the fixture. The private Browser fixture and tab were cleaned up.
- T1 complete: SDK-neutral typed definitions and structural policy filter. Captured wire-catalog SHA-256 snapshots using the actual old SDK helper before replacement; all three provider catalogs match after replacement with the Claude loader disabled. Four focused files passed (112 tests); Node TypeScript check passed.
- Dependency installation was unnecessary: the isolated worktree uses the existing dependency tree through an ignored relative symlink. No dependency mutation or SQLite rebuild occurred.

- T2 source complete: digest-addressed transformed trees shared by Desktop/Core stores, persisted session choices, stable Claude plugin views, conservative legacy retention, rename/history deletion hooks. Collection runs at owning-host startup before provider runtimes start; failed staging is removed immediately. Prepared-but-unadopted candidates are also eligible for startup collection. Six initial asset suites passed (30 tests); retention suite expanded to five cases.
- T3 source complete: independent refresh reservation, coalescing and cancellation state machine plus provider dequeue/steering gates. Initial gate/stream/retention run passed (28 tests). Full adapter integration remains in final validation.
- T4 source implemented: Claude SDK reload/cache hold and MCP ownership checks; Codex live-generation-only control requests with explicit empty roots and forced inventory read; Grok session-scoped MCP refresh plus truthful Skills/plugin limitations. Exported the installed Codex JSON schema offline to validate RPC inputs; no provider/model session was opened. Native mock tests passed, including cache deferral, partial failure, unsupported extensions, and native inventory requirements.

## Grok source correction during implementation

The user's request to inspect the local Grok source exposed native ACP extensions that the planning investigation missed. The local source baseline is `f049847ce9426ee3e33b452cd340f2ef6b900edb` (shell package 1.0.45); the installed dependency is 1.0.52. The same handlers are present in the official upstream source inspected on 2026-10-15. No live provider/model experiment was run.

- `$GROK_SOURCE/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs` dispatches `x.ai/session/update_mcp_servers`, `x.ai/skills/refresh-baseline`, and plugin extensions.
- `extensions/session_admin.rs` in that source validates the target session, replaces only its client-provided MCP seed, merges native managed/config/plugin sources, awaits the actor completion reply, and returns `{result:{ok:true}}`. `extensions/mcp.rs` provides a session-annotated inventory and `sessionMcpResolved`; omitting that marker is not success. Implement the session-scoped MCP path with bounded unsupported-method fallback and effective inventory verification.
- Skills baseline/reload entry points broadcast to every resident native session and acknowledge enqueueing rather than completion. Plugin actions rebuild shared plugin state, force recopy installed local plugins, and broadcast to other native sessions. These remain new-session-required in this current-session-only scope.
- This corrects the blanket Grok unsupported characterization; it does not authorize global refresh, provider reconstruction, configuration edits, or live model probes. The source-backed MCP capability fits D3's verified-native-only boundary.


## Final integration decisions

- Claude `/core` was evaluated against the installed export set. It does not expose the history/fork helpers used by the shared SDK loader (`forkSession`, `getSessionInfo`, `getSessionMessages`, `listSessions`, `getSubagentMessages`). Keep the loader on the root entry; generic MCP construction no longer invokes it. This avoids a second partially compatible loader contract. No dependency patch is required for the native interfaces used, and the existing lockfile and Electron SQLite binding remain unchanged.
- T5 complete: exact application-owned slash parsing and completion, typed local IPC/preload and remote Core action, ordinary-message rejection at host boundaries, authority/generation checks, and no successor or local-host fallback. Refresh feedback is an application/system event, never a synthetic user turn.
- Runtime/model/sandbox changes cancel queued refreshes and reject overlap with native application. Permission replies remain available. Grok native background idle checks run only for an explicitly queued refresh. Duplicate requests merge; cancelling during application can withdraw a queued follow-up without interrupting the active mutation.
- The new remote method is appended to the stable compact-grant directory. Revision-1 shorter grants retain exactly their prior permissions and do not acquire the new method; current policy revision is 2.
- Metadata contracts remain byte-identical in all three baseline wire-catalog snapshots. No native input/cache-token or first-call latency saving was measured. Discovery diagnostics expose only observed inventory counts/size and leave native Tool Search activation unknown.
- Source evidence paths use `$GROK_SOURCE/crates/codegen/xai-grok-shell/src/extensions/session_admin.rs`, `extensions/mcp.rs`, `extensions/task.rs`, and `session/acp_session_impl/run_loop.rs`. These source contracts and fake-provider tests are not a claim of live installed-runtime acceptance.


## Completion and validation

All T0-T6 work is complete in source. `pnpm typecheck` and `pnpm build` passed; `pnpm test`
passed 1,181 files / 7,417 tests, with 3 files / 6 opt-in tests skipped. SQLite binding hash is
unchanged. README retains only concise command usage after the owner's final instruction.

- [CHANGELOG_684](../../changelogs/recent-3-days/CHANGELOG_684_runtime-component-injection.md)
- [REVIEW_329 lead implementation audit](../../reviews/recent-3-days/REVIEW_329_runtime-component-boundaries.md)

No application restart, installation, deployment, dependency mutation, or real model probe occurred.
The isolated workspace and structured lease were retained at source completion. The owner subsequently authorized Git integration and structured cleanup; application activation remains separate.

The Tool Search follow-up clarified that preserving complete contracts does not itself prevent deferred loading. This implementation adds no demonstrated prompt-token reduction: native per-session deferral still needs direct evidence before claiming that optimization.
