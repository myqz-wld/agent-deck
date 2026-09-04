# Pi Adapter Design and Native Project Trust Integration

Status: completed
Created: 2026-08-23
Completed At: 2026-08-24
Base branch: `main`
Base commit: `e4482dd584f5afddd19fdd0a67d159eb1927566f`
Isolation: `.agent-deck/worktrees/agent-deck-01a02e24-baf-mt6u9cvy` (active, detached)

## Goal

1. Archive an evidence-backed Pi adapter feasibility and staged integration design before writing
   Pi production code.
2. Add persistent provider-native project-trust detection and an opt-in grant to the New Session
   flow for the three existing adapters: Claude Code, Codex CLI, and Grok Build.
3. Deliver the same trust workflow through Desktop-local and Remote/Relay/Full creation authority.
4. Keep project trust distinct from tool approval and OS sandbox controls.

## Scope

### In this implementation

- A durable Pi feasibility/design record; no Pi adapter production code.
- Trust detection for Claude Code, Codex CLI, and Grok Build.
- An unchecked trust control shown only when a durable native grant is absent and the owning host
  can persist one.
- Provider-native persistence only after the user presses Create.
- Desktop main/preload/renderer integration.
- Remote session-console contract, Full Core, and Relay Local Worker integration.
- Grok provider-container projection so a persistent Core-side native decision reaches the
  per-session ephemeral container home.
- Focused provider, IPC/contract, renderer, Core authority, and container tests.

### Explicitly out of scope

- Pi permission popups and Pi OS sandbox support.
- Pi production adapter, packaging, or deployment in this change.
- A global trust-management settings page or revoke workflow.
- Trust prompts for resume, handoff, teammate spawn, or worktree transition. Those paths inherit a
  persisted native decision if one already exists; this delivery adds a choice only to New Session.
- Broadening Codex project trust into per-hook hash trust.
- Treating project trust as tool-call approval or changing any selected permission/sandbox policy.

## Invariants

- Merely opening the dialog, changing the adapter/cwd, checking the box, or cancelling never
  mutates provider state.
- A selected grant is persisted immediately before provider startup and then re-read; verification
  failure blocks creation and preserves the authored prompt and attachments.
- The checkbox starts unchecked for every adapter/cwd/provider projection and is never stored in
  last-used defaults.
- Trust evidence is bound to adapter, effective provider configuration root, and canonical cwd.
- Stale reads never authorize a different adapter or directory.
- `unknown` is never converted to `trusted` or `untrusted` merely for UI convenience.
- Remote clients receive only a bounded status, reason code, and opaque revision. Provider-home and
  Workspace absolute paths never cross the session-console protocol.
- Full Core and Relay Local Worker detect and write trust on the machine that owns the provider
  process and provider home. Relay Server never does so.
- Provider config contents, credentials, absolute paths, and user names are absent from logs and
  final records.
- The implementation uses deterministic parsers, canonicalizers, state transitions, hashes, and
  writers. No LLM call owns a trust decision or an exact config mutation.

## Current Project Evidence

- `src/renderer/hooks/useSessionCreationOptions.ts` already resolves local creation metadata by
  adapter/cwd, fences stale async responses, and blocks submission until the current projection
  settles.
- `src/main/ipc/adapters-session-creation-defaults.ts` is the bounded main-process read boundary for
  local cwd-dependent creation metadata.
- `src/renderer/components/new-session/useRemoteSessionCreation.ts` already keys Remote capability
  requests by source, adapter, provider, and Workspace-relative cwd.
- `src/hosts/server-core/session-create-capabilities.ts` resolves the authoritative Core cwd and
  hashes the create descriptor into a capability revision.
- `src/hosts/server-core/session-console-authority.ts` performs validation before attachment
  persistence and provider startup, which is the correct trust mutation boundary.
- `src/hosts/server-core/provider-host-common.ts` assigns provider-private `HOME`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `GROK_HOME` under the owning Core/Worker boundary.
- Full runs providers in its appliance. Relay Local Worker owns Core, Workspace, provider homes,
  and provider processes; Relay Server carries metadata and transport only.
- Remote Grok sessions run in one container per session. `src/hosts/provider-session/node-mounts.ts`
  creates a fresh state/home directory and deletes it on release, so a container-only `--trust`
  decision is not persistent.
- `NewSessionForm` already renders adapter controls below the first-message authoring block. Trust
  needs a dedicated checkbox/note contract, not another string-valued option in
  `session-option-catalog.ts`.
- Main/preload changes require synchronized shared types, IPC registration, preload facade,
  renderer integration, validation, and a development restart.

## Provider Evidence

### Claude Code

- Agent Deck uses `settingSources: ['user', 'project', 'local']` for normal SDK sessions.
- Claude stores the per-directory `hasTrustDialogAccepted` flag in `$HOME/.claude.json` by
  default. When `CLAUDE_CONFIG_DIR` is explicitly set, current builds relocate the state file to
  `<effective CLAUDE_CONFIG_DIR>/.claude.json`.
- A temp-root `claude project purge --dry-run` spike proved that a custom `CLAUDE_CONFIG_DIR`
  receives `.claude.json` inside that directory.
- The native writer serializes through an atomic directory lock named `.claude.json.lock` and
  publishes unique `.claude.json.tmp.*` files. A filesystem-watch spike observed this exact
  protocol. Agent Deck can participate in the same lock instead of inventing an incompatible one.
- A controlled untrusted-project spike on Claude Code 2.1.237 proved that `claude -p` executed a
  project `SessionStart` hook while the project map remained empty. This matches the official
  statement that trust verification is disabled in non-interactive mode. Therefore an Agent Deck
  Claude session does not degrade exactly like Codex/Grok when the durable grant is absent.
- Persisting Claude trust is still meaningful for native interactive CLI use and trust-gated
  features such as worktree/goal flows. UI copy must state the provider-specific effect and avoid
  claiming the current SDK session was otherwise fully blocked.
- A selected Claude Gateway can declare its own `CLAUDE_CONFIG_DIR`; detection and persistence must
  use that effective root. Remote provider projection removes host-path environment overrides, so
  Remote Claude stays under its Core-owned provider home.
- Claude exposes no documented non-interactive trust-write command. The bounded implementation is
  a same-lock, latest-read JSON merge that preserves every unrelated key, writes mode `0600`,
  fsyncs, atomically renames, releases only its own lock identity, and verifies by re-read.

Official references:

- https://code.claude.com/docs/en/security
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/settings

### Codex CLI

- Official configuration defines `projects.<path>.trust_level` as `trusted` or `untrusted`.
  Untrusted/undecided projects skip project-scoped `.codex` configuration, hooks, and rules.
- Current upstream resolution checks a canonical exact cwd entry first, then the detected project
  root, then the main repository root. Linked worktrees can share the main checkout trust key.
- Agent Deck already has a pooled Desktop app-server client and Server Core app-server composition.
- A temp `CODEX_HOME` spike proved `config/value/write` accepts the quoted dynamic key path
  `projects.<canonical-key>.trust_level`, performs an `upsert`, and becomes visible to a subsequent
  `config/read`.
- Current generated app-server bindings expose `config/read({includeLayers:true,cwd})`, a version
  on each config layer, `config/value/write({keyPath,value,mergeStrategy,filePath?,expectedVersion?})`,
  and a versioned write response. The native writer should be used with the base user-layer version
  and followed by an authoritative re-read.
- Project trust does not automatically approve a modified/untrusted hook hash. The UI and record
  must not imply otherwise.

Official references:

- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/app-server
- https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs
- https://github.com/openai/codex/blob/main/codex-rs/git-utils/src/trust.rs

### Grok Build

- The official native store is `$GROK_HOME/trusted_folders.toml`, with records shaped as
  `[folders."<canonical path>"]`, `trusted`, and `decided_at`.
- Grok canonicalizes the workspace key to the repository/main-checkout root where safe. Trust uses
  most-specific ancestor semantics: an ancestor grant cascades, while a nearer explicit deny wins.
- Grok refuses filesystem root and the user's home as persistent trust roots. When folder trust is
  disabled, or the key is unrecordable, native behavior is effectively trusted without a durable
  grant.
- With folder trust enabled and no relevant project executable configuration, Grok currently
  permits project scope provisionally without writing a grant. The confirmed Agent Deck UI policy
  is broader: it offers persistent trust whenever no durable grant exists, not only after a
  trust-sensitive resource is discovered.
- Native `--trust` persists through Grok's own advisory `trusted_folders.toml.lock`, latest-read
  merge, mode-0600 temp write, fsync, and atomic rename. Desktop grant should use a bounded
  authenticate-free ACP startup with `--trust`, stop it after initialization, and verify the store.
- Full/Relay Grok containers have ephemeral homes. Core therefore keeps the exact native TOML
  shape in its persistent provider home under exclusive Core authority. Every container launch
  whose Core-side decision resolves trusted receives native `--trust`, causing the container's
  provider-visible workspace key to be trusted before project MCP/LSP/hooks load.

Official references:

- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-workspace/src/trust.rs
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-workspace/src/folder_trust.rs
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md

## Pi Adapter Feasibility and Selected Design

### Conclusion

The adapter is feasible. The recommended first implementation is an exact-version official
standalone Pi executable, one process per Agent Deck session, using Pi's documented strict-LF JSONL
RPC mode. Do not embed the npm SDK in Electron's main runtime: Pi 0.84.2 requires Node `>=22.19.0`,
while the repository's Electron 33.4.11 embeds Node 20.18.3. Official release archives already ship
standalone binaries for macOS, Linux, and Windows architectures with `SHA256SUMS`.

The version observed by this plan is 0.84.2. Implementation must pin the selected release and
checksums rather than silently downloading "latest" at build or runtime.

Official references:

- https://github.com/earendil-works/pi/releases
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md

### Process and RPC lifecycle

- Spawn `pi --mode rpc` with explicit cwd, provider/model/thinking selections, session persistence,
  and one absolute app-bundled extension path.
- Implement an LF-only byte framer; do not use Node `readline`, because Pi documents U+2028/U+2029
  as valid JSON-string content that generic line readers can split incorrectly.
- Correlate commands by generated ids. A successful `prompt` response means accepted/queued, not
  completed. Use `agent_settled` as the session-idle boundary; `agent_end` can still be followed by
  retry, compaction, or queued work.
- Map `message_update` deltas, message start/end, tool execution, queue, compaction, retry, and
  extension errors into Agent Deck's normalized event stream.
- Use `steer`, `follow_up`, and `abort` for active-turn control. Images are supported on prompt,
  steer, and follow-up commands.
- Call `get_state` after startup to capture Pi's native `sessionId` and session file without parsing
  terminal text. Persist the native identity for resume/recovery.
- Resume starts a fresh process with `--session <native-id-or-path>`. RPC has no supported cwd
  mutation; a worktree transition therefore needs a cold process restart/fork design and is not a
  hidden in-process `chdir`.

### Configuration and trust

- User/global Pi state is under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.
- Project settings/resources are under `.pi/`; ancestor `.agents/skills` can also be project-trust
  sensitive. Ordinary `AGENTS.md`/`CLAUDE.md` context discovery is separate.
- RPC is non-interactive. The first Pi delivery passes neither `--approve` nor `--no-approve`, so
  Pi respects `trust.json` plus `defaultProjectTrust`. With the default `ask`, an undecided project
  behaves untrusted in RPC and protected project resources are ignored.
- `--approve` and `--no-approve` are one-run project-resource overrides, not tool approvals. The
  first delivery does not expose them in Agent Deck.
- Surface Pi's safe trust warnings/diagnostics to the user. A later Pi trust UI can reuse the shared
  descriptor introduced by this plan, but it is outside the current three-adapter implementation.

Official references:

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/trust-manager.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/project-trust.ts

### Agent Deck MCP bridge

Pi intentionally has no built-in MCP client. Agent Deck should not depend on a third-party Pi MCP
package. Instead, ship one app-owned Pi extension and one lifecycle-bound private side channel:

1. Main/Core creates the same per-session Agent Deck MCP dispatcher and authenticated caller token
   used by existing adapters.
2. Pi RPC keeps stdin/stdout exclusively for Pi's strict JSONL protocol. The child receives a
   separate inherited duplex pipe (or a pair of private file descriptors) for a bounded, versioned
   Agent Deck bridge protocol.
3. The bundled extension is loaded explicitly with `-e <absolute bundled path>`. CLI extensions are
   available during Pi's pre-trust bootstrap, while untrusted project extensions are not, so a
   repository cannot replace this bridge.
4. The extension performs a startup `tools/list` handshake over the private channel and registers
   Pi tools from the returned bounded name/description/JSON-schema catalog. This catalog is derived
   deterministically from the same Agent Deck MCP tool definitions; it is not separately hand-copied.
5. A Pi tool invocation sends `{requestId, toolName, arguments}` over the private channel. The
   owning main/Core process authenticates the session, invokes the existing MCP dispatcher, and
   returns the bounded content/error result. The token and transport metadata never enter model
   text, session records, or logs.
6. Closing either process closes the channel, rejects pending calls, and retires the session token.
   Backpressure, maximum record size, maximum in-flight calls, timeouts, cancellation, duplicate ids,
   and malformed frames fail closed.
7. When `enableAgentDeckMcp` is disabled, do not load the extension and do not create the channel.

This is an adapter bridge to the existing MCP implementation, not a claim that Pi core supports MCP.

### Initial capability matrix

| Capability | First Pi adapter | Notes |
| --- | --- | --- |
| Create/resume | Yes | One standalone RPC process per Agent Deck session |
| Streaming/tool events | Yes | Normalize documented RPC events |
| Images | Yes | RPC prompt/steer/follow-up image payloads |
| Steer/follow-up/interrupt | Yes | Native RPC commands |
| Model/thinking selection | Yes | Native provider/model catalog and thinking RPC |
| Agent Deck MCP | Yes | Bundled extension plus private side channel |
| Native project trust UI | No | Respect `trust.json` and `defaultProjectTrust` |
| Permission popups | No | Explicitly advertise unsupported |
| OS sandbox | No | Explicitly advertise unsupported |
| Plan/session mode | No | Pi has no built-in equivalent |
| Hot cwd/worktree switch | No | Requires cold restart/fork design |

### Pi delivery stages

1. Pin and package the standalone binaries/checksums; add a protocol fixture and startup probe.
2. Add adapter registry/types/options, process lifecycle, RPC framing, event translation, identity,
   resume, model/thinking, attachments, steering, interruption, recovery, and focused tests.
3. Add the generated bundled extension and private Agent Deck MCP bridge with auth/lifecycle tests.
4. Add Remote/Relay/Full provider packaging and container/supervisor support after Desktop parity.
5. Consider Pi trust UI, permission UI, sandboxing, and cold worktree transitions as separate
   security/lifecycle projects.

The public adapter id/name and exact release to pin remain future Pi-implementation decisions; they
do not affect the current trust delivery.

## Selected Trust Architecture

### Shared descriptor

Add a provider-neutral descriptor to local creation defaults and Remote create capabilities:

```ts
type ProjectTrustReasonCode =
  | 'state-unreadable'
  | 'state-malformed'
  | 'state-unsafe'
  | 'provider-unavailable'
  | 'native-unsupported'
  | 'policy-disabled'
  | 'unsafe-project-root';

interface ProjectTrustDescriptor {
  status: 'trusted' | 'untrusted' | 'unknown' | 'unsupported';
  canGrant: boolean;
  reasonCode: ProjectTrustReasonCode | null; // bounded; renderer owns localized copy
  revision: `sha256:${string}`; // adapter + effective config root identity + canonical cwd + verdict
}
```

`untrusted` means there is no durable applicable native grant (or an explicit native deny), not
that every provider currently disables every project resource. This definition is necessary for
Claude's non-interactive bypass and Grok's provisional no-resource allow. Provider-specific help
text explains the concrete effect.

### Separate trust revision

- Keep trust outside the string-valued session option catalog.
- Do not fold the volatile trust verdict into Remote `capabilityRevision`; add the descriptor's own
  opaque revision and submit `{revision, grant}` with Create.
- Continue using `capabilityRevision` for adapter/options/attachments/sandbox/directory policy.
- On Create, re-describe trust for the final canonical cwd:
  - same revision: apply the selected action;
  - requested grant and current status is already trusted: accept idempotently;
  - previously untrusted and now externally trusted with no requested grant: accept safely;
  - a stable `unknown`/`unsupported` descriptor with no requested grant is allowed and preserves
    provider-native behavior;
  - previously trusted becoming untrusted, cwd/provider identity mismatch, a requested grant whose
    state is no longer safely grantable, or any other incompatible transition returns a conflict
    and refreshes the form.
- This preserves retryability after a successful grant and avoids invalidating unrelated capability
  metadata when only native trust changes.

### Mutation order

1. Parse and canonicalize final adapter/provider/cwd.
2. Validate ordinary capability revision and submitted trust revision.
3. If selected, acquire provider-native serialization, persist the grant, and re-read it.
4. Persist attachments.
5. Start the provider session.
6. Commit the Agent Deck session mutation/result.

Trust is an intentional external side effect of pressing Create. It is never performed while
resolving defaults or rendering the checkbox.

### Remote ownership and Grok projection

- Desktop-local requests use main-process provider state.
- Full Core and Relay Local Worker use their private provider homes and canonical host Workspace.
- Public Remote contracts carry Workspace-relative cwd plus status/revision only.
- Remote Grok's durable native-format store lives under the Core/Worker provider home, where one
  authority serializes updates. Because each provider container home is disposable, the transport
  resolves the durable status before launch and carries a private boolean through the versioned
  Core-to-supervisor launch contract. The shim adds native `--trust` before `agent --no-leader
  stdio` only when that durable status is trusted.
- Bump both the public session-console capability/create schema and the private provider-session
  container launch schema in the coordinated release. Older peers fail explicitly rather than
  silently dropping a trust request.

## UI Behavior

- While the authoritative trust descriptor is loading, retain the committed form and block Create
  through the existing configuration-readiness mechanism.
- For `untrusted && canGrant`, render an unchecked checkbox below the existing adapter controls:
  `信任此项目`.
- Supporting copy is provider-specific:
  - Claude: saves Claude's native project trust; Agent Deck's current non-interactive SDK mode can
    still load project configuration without this saved decision.
  - Codex: enables project `.codex` config/hooks/rules; it does not approve tool calls or hook hashes.
  - Grok: trusts the repository/folder tree for project MCP/LSP/hooks and related project code.
- `unknown` or non-grantable state renders a bounded note, never a checked/disabled checkbox that
  could be mistaken for consent.
- Changing adapter, provider, cwd, Remote source, or authoring cycle resets the selection to false.
- Grant failure or stale projection leaves the prompt and images in place and offers configuration
  retry.

## Blindspot Pass

- Claude durable trust and SDK headless execution are different concepts; a shared label must not
  promise identical runtime gating.
- Codex exact-cwd entries can override repo-root entries, and linked worktrees can resolve to the
  main checkout. A naive `projects[cwd]` lookup/writer is incorrect.
- Codex project trust and per-hook hash trust can diverge.
- Grok's most-specific ancestor record can override a broader grant or deny.
- Grok folder-trust disabled, unsafe home/root keys, and no-resource provisional allows are distinct
  from a durable store grant.
- A provider state file can be missing, malformed, symlinked, too large, wrong-owner, or concurrently
  modified. Every case needs bounded fail-closed diagnostics.
- A checkbox remembered by adapter would authorize a different directory; it must stay outside
  last-default storage.
- Provider config can change after detection and before Create; the independent trust revision and
  re-read prevent stale authorization.
- Grant succeeds but provider startup, attachment persistence, or Agent Deck metadata commit can
  still fail. Whether to retain or compensate the grant is a user-owned persistence choice below.
- Remote Grok's provider home is ephemeral per container; a launch flag without Core persistence
  would violate the selected behavior.
- Resume, handoff, spawn, and worktree paths bypass New Session. This delivery intentionally does
  not pretend the checkbox is a universal policy engine.

## Decision Ledger

### TRUST-01 — Adapter scope

- Owner: user
- Status: confirmed
- Answer: existing adapters — Claude Code, Codex CLI, and Grok Build.

### TRUST-02 — Persistence semantics

- Owner: user
- Status: confirmed
- Answer: persist provider-native trust only after the user presses Create with the option selected.

### TRUST-03 — Execution topology

- Owner: user
- Status: confirmed
- Answer: Desktop, Remote, Relay, and Full are included in the same delivery.

### TRUST-04 — Visibility trigger

- Owner: user
- Status: confirmed from the explicit request
- Answer: offer persistent trust whenever the canonical project lacks a durable applicable native
  grant, rather than only when trust-gated project resources are currently detected.

### TRUST-05 — Detector failure behavior

- Owner: user
- Impact: New Session availability when provider state cannot be read authoritatively
- Options:
  1. Allow creation with a visible diagnostic and no trust checkbox (recommended; preserves current
     provider-native behavior and never fabricates consent).
  2. Block creation until trust detection succeeds (stricter but turns a diagnostic/config issue
     into a total session-creation outage).
- Status: confirmed
- Answer: allow creation with a visible diagnostic and no trust checkbox.

### TRUST-06 — Grant compensation after later create failure

- Owner: user
- Impact: persistence/rollback and concurrency with native CLIs
- Options:
  1. Keep the successfully persisted trust grant even if provider session creation later fails
     (recommended; the user explicitly accepted persistence, and rollback could erase a decision
     already observed by another native process).
  2. Attempt a compare-and-delete rollback only if the exact record still equals Agent Deck's write
     (more transactional, but another process may have already relied on the grant and provider
     stores differ in rollback support).
- Status: confirmed
- Answer: keep the successfully persisted native trust grant. Do not compensate it after a later
  attachment, provider-startup, or Agent Deck metadata failure.

### PI-01 — First Pi trust behavior

- Owner: user
- Status: confirmed by prior discussion
- Answer: pass neither `--approve` nor `--no-approve`; respect Pi's native saved trust and
  `defaultProjectTrust`, and surface diagnostics.

### PI-02 — Pi permission/sandbox scope

- Owner: user
- Status: confirmed
- Answer: permission popups and OS sandbox are excluded from the first Pi adapter.

## Targeted Spike Reports

### S1 — Claude effective state root and serialization

- Question: where does `.claude.json` live with `CLAUDE_CONFIG_DIR`, and can Agent Deck serialize
  against the native writer?
- Method: isolated config/home, native `project purge --dry-run`, recursive filesystem watch.
- Result: state appeared at `<CLAUDE_CONFIG_DIR>/.claude.json`; native writes created
  `.claude.json.lock` as an exclusive directory and unique temp files before rename.
- Conclusion: follow effective Gateway config root and share the native lock name/protocol.
- Remaining risk: direct state schema is not a documented public API; keep the merge minimal and
  contract-test the pinned Claude version.

### S2 — Claude headless trust effect

- Question: does an absent durable grant suppress project hooks in non-interactive mode?
- Method: isolated untrusted Git project with a project `SessionStart` marker hook, isolated Claude
  state, local failing API endpoint.
- Result: the hook ran before the API failure; the native projects map remained empty.
- Conclusion: Agent Deck must describe a saved native decision, not claim all Claude project
  execution depends on it.
- Remaining risk: individual Claude features can still impose their own trust check.

### S3 — Codex native read/write

- Question: can Agent Deck detect and persist project trust through supported app-server RPC?
- Method: generated current protocol bindings and used an isolated `CODEX_HOME` app-server.
- Result: `config/read` exposes effective layers and versions; `config/value/write` upserted a quoted
  project key and re-read as trusted.
- Conclusion: use native app-server write with the user-layer expected version and re-read.
- Remaining risk: mirror the current upstream exact/project/main-repo key algorithm with focused
  worktree tests.

### S4 — Grok native semantics and container lifetime

- Question: what does Grok persist, and does Remote container state survive?
- Method: official source/docs plus local redacted store-shape inspection and provider supervisor
  lifecycle inspection.
- Result: native TOML/ancestor/lock semantics are explicit; Agent Deck deletes each container state
  directory on release.
- Conclusion: use native `--trust` for Desktop and a persistent Core native-format decision plus
  per-container native `--trust` projection for Full/Relay.
- Remaining risk: validate both rootless Podman and Docker Desktop argument/mount namespaces in
  provider-session tests.

### S5 — Pi runtime and protocol

- Question: can Pi align with Agent Deck without embedding a newer Node runtime or relying on a
  third-party MCP package?
- Method: official release/package/RPC/trust/extension sources and current Electron runtime probe.
- Result: official standalone binaries and checksums exist; RPC covers required lifecycle/events;
  Pi requires Node 22.19 while Electron embeds Node 20.18; an app-owned extension can register tools.
- Conclusion: standalone RPC plus a private extension bridge is feasible.
- Remaining risk: Pi public protocol is documented but not version-negotiated in the current type;
  pin the binary and add golden protocol fixtures before adapter implementation.

## Cross-Task Validation Strategy

- Pure core tests for canonicalization, descriptor revisions, exact/ancestor/provider-root decisions,
  unsafe roots, disabled gates, malformed/oversized/symlinked files, and path-free diagnostics.
- Claude temp-root tests for effective config root, native lock contention, JSON preservation,
  mode-0600 atomic write, Gateway root selection, verification, and no mutation on read/toggle.
- Codex app-server contract tests for exact/project/repo-root precedence, linked worktrees, quoted
  dynamic keys, expected-version conflict, managed override, and re-read.
- Grok tests for most-specific ancestor semantics, explicit deny override, unsafe home/root,
  native probe argument construction, persistent Core store, and container `--trust` projection.
- Local IPC tests for bounded input, descriptor identity, stale revision, mutation-before-attachments,
  unsupported adapters, and safe errors.
- Remote contract/authority tests for schema bump, no absolute paths, separate trust revision,
  idempotent already-trusted retry, mutation ordering, Relay/Full owner boundary, and capability
  compatibility failure.
- Renderer tests for loading, provider/cwd invalidation, hidden/trusted/unknown states, unchecked
  reset, Chinese copy, placement below controls, no mutation on toggle/cancel, and authored-content
  preservation after failure.
- Full `pnpm typecheck`, `pnpm test`, `pnpm build`, file-size/review-expiry checks, then cleanly restart
  development because main/preload change.

## Executable Tasks

### T1 — Archive the approved design and establish shared contracts

- Owner: implementation session
- Dependencies: TRUST-05/06 confirmed and final plan approved
- Write areas: `ref/plans/`, shared session types, Remote session-console contracts
- Steps: archive this plan; add descriptor/request parsers and schema versions; keep trust separate
  from string options; add exact parser/round-trip tests.
- Done: both local and Remote surfaces have a bounded, path-free descriptor and request contract.

### T2 — Implement provider-native detector/grant ports

- Owner: implementation session
- Dependencies: T1
- Write areas: new focused modules under `src/main/adapters/project-trust/`, Codex app-server ports,
  Server Core provider composition
- Steps: implement shared orchestration and provider hosts described above; add timeouts, native
  serialization, re-read verification, safe diagnostics, and provider-root selection.
- Done: provider temp-home suites prove read-only detection and exact mutation behavior.

### T3 — Integrate Desktop New Session

- Owner: implementation session
- Dependencies: T1, T2
- Write areas: local defaults IPC/preload, adapter create IPC, session creation hook/actions/form/dialog
- Steps: attach descriptor to the existing cwd-dependent projection; add dedicated checkbox/note;
  submit revision/grant; grant before attachments/provider; reset on identity changes.
- Done: all local UI/IPC behavior and no-side-effect cases pass.

### T4 — Integrate Remote/Relay/Full authority

- Owner: implementation session
- Dependencies: T1, T2
- Write areas: remote source types/client, capabilities, authority, runtime composition, tests
- Steps: expose descriptor from provider-owning Core, submit trust request, validate independent
  revision, persist before attachments/provider startup, and keep paths private.
- Done: Full and Relay Local Worker contract/authority suites pass; Relay Server remains state-blind.

### T5 — Project durable Grok trust into ephemeral provider containers

- Owner: implementation session
- Dependencies: T2, T4
- Write areas: provider Grok transport/runtime, provider-session launch contract, OCI/shim/tests
- Steps: bump private schema; carry only a boolean trusted verdict; add native `--trust` at the shim;
  verify trusted and untrusted launch argv for Podman and Docker Desktop.
- Done: a second container session inherits the persistent Core decision without sharing a
  per-session home or exposing a host path publicly.

### T6 — Documentation, validation, and final records

- Owner: implementation session
- Dependencies: T3-T5
- Write areas: changelog, review record/indexes, final plan execution state
- Steps: keep the dedicated Pi/trust design in this plan and leave `README.md` unchanged per the
  user's final placement correction; run targeted/full validation; run review-expiry and
  self-review; leave live process restart to the user; archive records and remove/retain `.ref`
  material per repository policy.
- Done: all required commands pass, no required review issue remains, and final records/indexes are
  current.

## Parallelization

No sub-agent delegation is authorized for this plan. After approval, execute sequentially in one
isolated worktree. T3 and T4 touch their own UI/authority surfaces but both consume T1/T2 contracts;
keeping them in one implementation session avoids protocol drift and overlapping shared types.

## Checkpoint C Review

- Scope: the current implementation ends at three-adapter trust support and a durable Pi design;
  no Pi runtime, permission-popup, or sandbox code is implied.
- Decisions: TRUST-01 through TRUST-06 and PI-01 through PI-02 are confirmed. The future Pi adapter
  id and binary pin are explicitly outside this implementation and do not block it.
- Authority: Desktop main or provider-owning Core/Relay Local Worker performs every read/write;
  renderer and Relay Server never receive provider paths or mutate provider state.
- Consent: only Create with an explicitly checked option mutates trust. Detection, toggling, and
  cancel remain read-only. A successful native grant is retained after a later create failure.
- Failure behavior: a stable `unknown` result is diagnostic-only and does not block Create; a
  requested grant cannot proceed when it cannot be authoritatively persisted and verified.
- Concurrency: native locks/version checks, latest-read merges, independent revisions, and re-read
  verification cover concurrent provider/Agent Deck writers without whole-file replacement.
- Lifecycle: trust mutation precedes attachments and provider startup; Remote Grok projects the
  durable Core decision into each disposable provider container.
- Privacy: public schemas and diagnostics are path-free and bounded; only opaque hashes leave the
  provider-owning authority.
- Validation: provider temp homes, IPC/contracts, renderer states, Remote authority, container argv,
  full typecheck/test/build, review expiry, and main/preload restart are all explicit exit gates.
- Review result: internally consistent and executable; no unresolved decision blocks final approval.

## Model Boundary

No production LLM calls are introduced by this design. Provider trust detection, key selection,
config merging, catalog projection, request validation, hashing, and persistence are deterministic.
Pi and the existing adapters make their normal model calls only after session creation succeeds.

## Execution State

- Completed: T1-T6, including the Pi design, all three provider-native trust hosts, Desktop and
  Remote/Relay/Full creation paths, Grok container projection, dedicated UI consent, final records,
  file rebucketing, and the 500-line split pass.
- Validation performed: provider/contract/IPC/Core/renderer focused suites; `pnpm typecheck`;
  complete `pnpm test` with 1,007 files and 6,307 tests passed plus 2 files/3 opt-in tests skipped;
  `pnpm build`; review expiry; and `git diff --check`. Further process termination/development
  restart is intentionally left to the user after the explicit no-process-mutation direction.
- Review: `REVIEW_262_native-project-trust.md` closed 4 MEDIUM and 2 LOW findings with no open
  material issue.
- Final record: `CHANGELOG_628_native-project-trust.md`.
- README: unchanged after the user's explicit documentation-placement correction.
- Isolation: active in the repository-relative worktree recorded above.
- Next action: preserve the completed worktree on a durable branch/commit and hand the result back
  to the user.

## Cold-Start Instruction

Read `ref/plans/recent-month/PLAN_44_pi-adapter-project-trust.md`, then verify the completed trust
implementation and final records against the preserved worktree branch. Pi production work remains
a separate future delivery.
