---
plan_id: PLAN_31
title: Linux Remote Core, SSH, Relay, Feishu, and Workspace foundation
status: completed-with-follow-up
created_at: 2026-08-03
updated_at: 2026-08-06
completed_at: 2026-08-06
base_branch: feature/linux-remote-core-ssh-im
final_commit: da3293ac2de2dce0b366d946ba5ec70097268721
merged_main_commit: 523a5b56c61178b341b9e7650a74f9569b0246a3
related_changelog: CHANGELOG_565
successor_plan: ref/plans/recent-3-days/PLAN_32_remote-local-capability-parity.md
---

# Linux Remote Core / SSH / IM Continuation Plan

Updated: 2026-08-06

## Archive status

The Remote Core, direct SSH, Relay/Worker, Feishu gateway, Local/Remote source-mode, credential
lifecycle, and Workspace-bound Worker foundation described here was delivered through
`da3293ac2de2dce0b366d946ba5ec70097268721`. The branch then merged `origin/main` at
`523a5b56c61178b341b9e7650a74f9569b0246a3` without changing those product decisions.

The unfinished Local/Remote feature-parity and provider-sandbox composition work moved to
`ref/plans/recent-3-days/PLAN_32_remote-local-capability-parity.md`. This archive does not claim real Full Podman,
systemd/sshd, target-Linux native-module, or live Feishu provider acceptance.

## Goal and invariants

Extract an Electron-free, Node 22 Server Core that supports Local and Remote desktop sources, direct
Server Core and Relay deployments, and owner-equivalent SSH/Feishu clients without duplicating the
desktop business UI.

- Desktop exposes only `Local` and `Remote` data-source modes; both reuse the existing business UI
  and source-neutral view-model contracts.
- Server deployment topology is separately `Server Core` or `Relay + Worker`.
- The macOS Electron client can host a Local Worker for Relay without requiring compute or provider
  binaries on the Relay server.
- A Local Worker runs inside one outer Workspace Sandbox and can observe only that sandbox's
  workspace plus its exact private runtime state. Provider-native sandbox selection remains the
  unchanged, user-selected child sandbox and can only narrow the outer boundary.
- Except for the outer Workspace Sandbox boundary, Local Worker retains normal Agent Deck
  functionality; Remote is not a reduced provider/runtime mode.
- Local and Remote use one source-neutral New Session interaction. The selected source supplies the
  authoritative adapter catalog, create-option capabilities, and directory policy; unsupported
  controls are disabled with a concrete reason and are never silently dropped or routed to Local.
- Local capability parity is the default product contract, not an optional follow-up. A missing
  Remote projection for an existing Local provider, option, attachment, or business surface is an
  implementation gap that keeps this plan incomplete; only a real provider/runtime limitation or
  an outer-sandbox composition conflict may remain capability-disabled.
- Relay has no business queue, persistence fallback, or local compute fallback.
- Credentials remain main/server owned, independently revocable, and exact identity/surface bound.
- All child/worker/transport lifecycle operations stay bounded and fail closed.
- Do not start, stop, restart, or kill the shared dev/Electron instance or unrelated processes.
- Keep work unstaged/uncommitted; never stash/reset user changes. Preserve an empty Git index.
- Do not claim real Linux, Podman, systemd, sshd, Feishu, or provider acceptance without running it.
- Every changed ordinary TS/TSX file must remain below 500 split lines.

## Confirmed scope and exclusions

In scope: Electron-free Core boundaries, Local/Remote source adapter, SSH/Relay/Worker/Feishu
transport and lifecycle, a macOS Electron-hosted Local Worker with an outer Workspace Sandbox,
normal provider/runtime capability parity inside that sandbox, Linux packaging/static contracts,
deterministic tests, production build, architecture gates, and durable change records.

Excluded until an explicit environment is available: shared dev-process restart, Ubuntu/EL9
systemd/Podman/sshd acceptance, live Feishu credentials/WebSocket/OpenAPI, and target-Linux
native-module acceptance. A real macOS Local Worker -> Relay -> Codex session is now an explicit
acceptance gate rather than an exclusion.

## Current progress

- The prior approximately 99.5% estimate is withdrawn. The real smoke co-located a Linux Worker on
  the Relay host and proved the routed protocol path, but it did not prove the confirmed macOS
  Electron-hosted Worker or its outer Workspace Sandbox. Delivery is reopened until that product
  path and a live Codex session pass.
- P1-P3 Local/Remote UI, direct SSH, Relay/Worker, Feishu, credential revocation, pending authority,
  shutdown, packaging, and cross-track review findings are repaired and targeted-review clear.
- One hundred twenty-seven bounded extraction slices are complete (`CHANGELOG_437` through
  `CHANGELOG_563`).
- One hundred twenty-one executable Node 22 boundary candidates pass the architecture bundle gate.
- Slices 27-115 moved every known `?nodeWorker` transform into explicit desktop hosts and separated
  provider registry, runtime settings/repository, per-session client construction, and background
  Codex quota, oneshot instance-pool, Grok/Codex summary, Claude MCP attachment, and Claude adapter
  plus Codex/Grok adapter construction, Claude SDK injection discovery, browser owner registry plus
  per-owner tab collection ownership, Grok/Codex/Claude live token-rate observation, and Claude
  runtime metadata persistence decisions, Claude create/resume defaults, Claude live-session
  lifecycle policy, Claude pending cancellation/close cleanup state, and Claude final registration
  sequencing, Claude native-fork cleanup aggregation, Claude live/background usage probing, and
  Claude native-fork transcript/SDK orchestration, Claude sandbox option policy, and Claude
  settings-environment parsing/assignment policy, Claude hook installation ownership, Claude
  ordinary message ingress/queue/idempotency policy, Claude tool-permission/pending decision policy,
  Claude lazy user-message materialization/FIFO dequeue policy, and Claude pending-response,
  timeout, and permission-mode transition policy, Claude Gateway native-fork transcript-root
  admission, Claude Gateway settings-backed sandbox derivation/private materialization, Claude SDK
  child-runtime environment/native-binary selection, Claude recovery transcript/cwd probe and
  fallback policy, Claude live cwd runtime replacement/rollback and queue migration, Claude Gateway
  profile discovery/settings projection, Claude SDK query-option construction/MCP namespace
  injection, Claude pending-outgoing projection/submitted-message cancellation, and Claude provider
  user-message echo acceptance/late-echo fencing, Claude progressive/final-result usage
  reconciliation, Claude context/window usage attribution, and Claude message-translation fallback,
  permission persistence/compact-failure state, Claude text/image tool-result file-change state, and
  the complete Claude SDK message dispatcher behind aggregate identity/clock/runtime/state ports,
  Claude stream terminal resolver/usage/claim/private-settings cleanup behind a finalizer host,
  Claude first-id/spawn/fork/phantom/fallback identity adoption behind an exact persistence host, and
  Claude first-message timeout/interrupt/map fallback behind a bounded clock/diagnostic host, and the
  complete Claude provider stream loop behind one aggregate desktop host, and provider-neutral
  model-option persistence/live application/rollback behind explicit repository and diagnostic
  ports, session-creation Codex/Gateway/home/environment defaults behind an explicit desktop host,
  and provider registration, partial-init diagnostics, plus session close/rename hooks behind an
  explicit host-neutral composition, complete session close/archive/reactivate/pin/delete ordering
  behind repository, Browser, team, event, token, handoff, and worktree host ports, and the complete
  SessionManager public surface behind an explicit host-neutral facade, and Grok claim, release,
  native-id, deletion, and failed-startup cleanup behind an injected SessionManager port, and Claude
  adapter fork rollback plus create/resume claim ownership behind its own injected manager port,
  including recovery close-epoch fencing, lifecycle restoration, stream terminal claim release,
  provider-session identity persistence, pending cancellation, close/rollback cleanup, final
  create-session native-id persistence, and read-only usage probe claims through that same port,
  then injected the live create/defaults, recovery reader/freshness/filesystem, restart/model/usage,
  pending-response, cwd-transition, ordinary-message, lifecycle, pending-outgoing, and aggregate
  stream-processor, create-session finalization, tool-decision identity/clock/diagnostic, and SDK
  query loading/runtime/binary/injection/sandbox/MCP/options/metadata/Gateway-settings hosts through
  adapter initialization, then moved cold-restart diagnostics into the injected restart host,
  shared JSONL fallback diagnostics into caller-supplied ports, disconnect-recovery diagnostics into
  the existing recovery host, safe display-text policy into a provider-neutral Core, and executable
  Node boundaries around the complete create-session, JSONL fallback, and disconnect-recovery
  orchestrators, then moved recovery continuation spool/checkpoint ownership behind a shared
  provider-neutral host so the complete Claude SDK bridge bundles without rediscovering desktop
  ownership and the Codex bridge delegates the same operations through adapter composition, then
  injected one aggregate Codex bridge runtime host for diagnostics, session/token lifecycle,
  persistence, configuration, client registry, handoff/worktree authority, upload cleanup, Browser
  disposal, and live-rate/model operations so the complete Codex SDK bridge is now an executable
  Node 22 candidate, then injected one aggregate Grok bridge runtime host for transactional session
  persistence/publication, diagnostics, live token-rate observation, handoff ingress, and pending
  worktree-transition authority so the complete Grok bridge is also an executable Node 22 candidate.
  The concrete top-level Claude, Codex, and Grok `AgentAdapter` classes now also consume explicit
  bridge, fork, hook, provider, diagnostic, and summary hosts; their index modules are desktop-only
  singleton facades and all three complete classes are executable Node 22 candidates. Their shared
  `AdapterContext` now consumes structural hook-server and route-registry ports, and one immutable
  Node Core factory constructs the same composition envelope for desktop and headless hosts. A
  second Node Core factory now constructs isolated Claude/Codex/Grok value sets from explicit hosts;
  desktop runtime composition no longer imports their singleton indexes. Grok hook installation
  now reports status failures through an injected observer, with desktop logger ownership isolated
  in a host adapter. Shared hook diagnostics and Grok route construction now also consume explicit
  host diagnostics without importing desktop logger/run-context state. One immutable aggregate
  factory now constructs the complete concrete Grok adapter host from explicit values and is shared
  by desktop and Linux composition. The concrete headless runtime now owns provider settings,
  repositories, metadata, Claude/Codex/Grok hosts, session-console authority, bounded provider
  lifecycle, and a private live credential file. It is shipped as a seventh isolated Linux role
  with fixed provider executable paths and no desktop singleton or Browser fallback.
- Latest gates: focused concrete Server Core/provider coverage 14 files / 90 tests;
  typecheck/architecture with 121 candidates; production build with 799 main modules; seven-role
  Linux headless verification and all four deployment static checks; canonical Electron full suite
  761 files plus 1 skipped / 5120 tests plus 1 skipped; logger/diff/whitespace/499-line/index gates
  pass.
- The credential foundation now uses purpose-discriminated v2 files: Relay Worker and Client
  identities are issued by separate commands, the fresh headless bundle validates both paths, and
  Electron rejects Worker files without persisting or previewing Worker/workspace state.

## Active checklist

- [x] Backlog checkpoint worker host boundary and Node candidate.
- [x] Background checkpoint worker host boundary and Node candidate.
- [x] Storage-maintenance worker host boundary and Node candidate.
- [x] Provider lifecycle registry Core/desktop diagnostics boundary and Node candidate.
- [x] Session-creation provider settings/config host boundary and Node candidate.
- [x] Codex native-fork target runtime settings host boundary and Node candidate.
- [x] Codex live create/resume repository/settings host boundary and Node candidate.
- [x] Codex per-session client construction host boundary and Node candidate.
- [x] Codex background usage snapshot host boundary and Node candidate.
- [x] Codex oneshot instance-pool host boundary and Node candidate.
- [x] Grok periodic summary settings host boundary and Node candidate.
- [x] Codex periodic summary settings/execution host boundary and Node candidate.
- [x] Claude MCP session attachment host boundary and Node candidate.
- [x] Claude adapter initialization host boundary and Node candidate.
- [x] Codex adapter initialization host boundary and Node candidate.
- [x] Grok adapter composition/settings host boundary and Node candidate.
- [x] Claude SDK injection settings/path discovery host boundary and Node candidate.
- [x] Browser owner registry lease/capacity lifecycle boundary and Node candidate.
- [x] Browser per-owner tab collection/active-selection boundary and Node candidate.
- [x] Grok live token-rate state/observer boundary and Node candidate.
- [x] Codex live usage watermark/rate host boundary and Node candidate.
- [x] Claude live decode-rate state/host boundary and Node candidate.
- [x] Claude runtime model/effort metadata host boundary and Node candidate.
- [x] Claude create/resume model/sandbox/effort/Gateway defaults boundary and Node candidate.
- [x] Claude close/rollback/retirement/permission-mode lifecycle boundary and Node candidate.
- [x] Claude pending cancellation/close cleanup boundary and Node candidate.
- [x] Claude session registration/finalize boundary and Node candidate.
- [x] Claude native-fork discard cleanup boundary and Node candidate.
- [x] Claude live/background account usage boundary and Node candidate.
- [x] Claude native-fork transcript discovery and SDK orchestration boundary and Node candidate.
- [x] Claude sandbox policy/desktop diagnostics boundary and Node candidate.
- [x] Claude settings environment I/O/diagnostics boundary and Node candidate.
- [x] Claude hook installer/status diagnostics boundary and Node candidate.
- [x] Claude ordinary message ingress/handoff/diagnostics boundary and Node candidate.
- [x] Claude tool-permission/pending/abort decision boundary and Node candidate.
- [x] Claude queued user-message materialization/FIFO/retirement boundary and Node candidate.
- [x] Claude pending-response/timeout/hot-cold-mode transition boundary and Node candidate.
- [x] Claude Gateway native-fork transcript-root safety boundary and Node candidate.
- [x] Claude Gateway settings-backed sandbox derivation/private-file boundary and Node candidate.
- [x] Claude SDK child-runtime/native-binary selection boundary and Node candidate.
- [x] Claude recovery transcript/cwd probe policy boundary and Node candidate.
- [x] Claude live cwd runtime replacement/rollback boundary and Node candidate.
- [x] Claude Gateway profile discovery/settings projection boundary and Node candidate.
- [x] Claude SDK query-option construction/MCP namespace boundary and Node candidate.
- [x] Claude pending-outgoing projection/cancellation boundary and Node candidate.
- [x] Claude provider user-message echo acceptance/fencing boundary and Node candidate.
- [x] Claude progressive/final-result usage reconciliation boundary and Node candidate.
- [x] Claude context/window usage attribution boundary and Node candidate.
- [x] Claude message translation model/permission/compact state boundary and Node candidate.
- [x] Claude message text/image file-change state boundary and Node candidate.
- [x] Claude complete SDK message translation aggregate-host boundary and Node candidate.
- [x] Claude stream terminal cleanup/claim/barrier boundary and Node candidate.
- [x] Claude stream first-id/spawn/fork/fallback identity boundary and Node candidate.
- [x] Claude stream first-message timeout/interrupt/map-fallback boundary and Node candidate.
- [x] Claude complete provider stream processor aggregate-host boundary and Node candidate.
- [x] Shared provider model-option persistence/live rollback boundary and Node candidate.
- [x] Session-creation concrete provider/home/environment default-source host hardening.
- [x] Provider registration/partial-init/session lifecycle composition boundary and Node candidate.
- [x] Session close/archive/reactivate/pin/delete lifecycle boundary and Node candidate.
- [x] Complete SessionManager facade/host injection boundary and Node candidate.
- [x] Grok bridge/runtime SessionManager injection boundary and Node candidate.
- [x] Claude adapter/create-session SessionManager injection boundary and Node candidate.
- [x] Claude recovery SessionManager injection through the existing Node candidate.
- [x] Claude stream finalization/identity SessionManager injection through the existing candidate.
- [x] Claude close/cancellation/final registration SessionManager injection through that candidate.
- [x] Claude live/background usage SessionManager injection through the existing candidate.
- [x] Claude live create/resume defaults, persisted identity, and transient repository cleanup injection.
- [x] Claude disconnect recovery persisted-session reader injection.
- [x] Claude cold-restart persistence, publication, and rename-subscription host injection.
- [x] Claude recovery transcript-freshness event-repository read injection.
- [x] Claude live provider-switch Gateway validation through the injected create/default host.
- [x] Claude provider-model persistence/publication/diagnostics host injection.
- [x] Claude recovery transcript/cwd filesystem host injection through the existing Core.
- [x] Claude live/background usage SDK/binary/path/clock host injection.
- [x] Claude pending-response persistence/publication/diagnostics/clock host injection.
- [x] Claude cwd-transition persisted-session reader host injection.
- [x] Claude ordinary-message ingress/diagnostics/clock host injection.
- [x] Claude interrupt/close/retirement/permission-mode lifecycle host injection.
- [x] Claude pending-outgoing cancellation/tombstone host injection.
- [x] Claude aggregate stream-processor host injection and direct Core construction.
- [x] Claude create-session finalization host injection and direct Core calls.
- [x] Claude create-session tool-decision request identity/clock/diagnostic host injection.
- [x] Claude create-session SDK query aggregate host injection.
- [x] Claude cold-restart diagnostic host injection.
- [x] Claude shared JSONL fallback diagnostic injection.
- [x] Claude disconnect-recovery diagnostic host injection.
- [x] Safe diagnostic text Core and complete Claude create-session Node bundle boundary.
- [x] Complete Claude JSONL fallback and disconnect-recovery Node bundle boundaries.
- [x] Recovery continuation contract/host ownership and complete Claude SDK bridge Node boundary.
- [x] Codex recovery continuation host injection and complete-bridge residual leak probe.
- [x] Complete Codex SDK bridge aggregate runtime-host injection and Node boundary.
- [x] Complete Grok Build bridge aggregate runtime-host injection and Node boundary.
- [x] Top-level Claude/Codex/Grok AgentAdapter host-injection boundaries and Node candidates.
- [x] Provider AdapterContext hook/route ports and immutable Node composition factory.
- [x] Isolated provider Adapter set factory and desktop singleton-import removal.
- [x] Grok hook installer observer/desktop logger boundary and Node candidate.
- [x] Shared hook route diagnostics host and Grok hook route Node boundaries.
- [x] Complete Grok aggregate value-host factory and desktop reuse.
- [x] Complete Claude aggregate value-host factory, explicit hook diagnostics, and desktop reuse.
- [x] Complete Codex aggregate value-host factory, hook ports, and desktop reuse.
- [x] Concrete Electron-free Core provider settings/composition and repository ownership.
- [x] Target Linux/native artifact packaging and deterministic static validation.
- [x] Real Relay/Worker/project-client SSH smoke under systemd user services on Ubuntu 24.04 ARM64.
- [x] Confirm the macOS outer-sandbox engine, Workspace Sandbox cardinality, and private-state root.
- [x] Add a terminal-managed platform Worker service lifecycle independent from Local/Remote selection.
- [x] Separate Relay Worker and Client issuance and keep Worker credentials out of Electron.
- [x] Add terminal-only Worker configure/start/status/stop/remove and its private credential store.
- [x] Enforce the outer Workspace Sandbox before Worker/Core/provider construction.
- [ ] Preserve normal provider, pending, Browser/MCP, worktree, and runtime behavior inside it.
- [ ] Replace the reduced Remote create form with the shared New Session presentation and an
  authoritative Remote Core adapter/create-capability descriptor. Preserve provider/model/thinking
  and provider-native permission/session/sandbox choices plus initial attachments at Local parity.
  Disable only options the selected authoritative adapter truly cannot support or whose sandbox
  policy cannot safely compose with the outer Workspace boundary; never send an empty replacement
  silently and never fall back to Local APIs.
- [x] Keep Workspace host paths, topology, and instance identity out of renderer/remote DTOs.
- [x] Run a real Mac Worker -> Relay -> Codex session and verify routed history plus Workspace
  write/outside-read denial after a Worker restart. No pending request was needed by this turn.
- [ ] Real Full Podman/Quadlet/manager acceptance on Ubuntu 24.04 or EL9.
- [ ] Live Feishu/provider acceptance with real credentials, kept separate from deterministic claims.

## First next step

Finish the source-neutral New Session contract and full Local/Remote capability parity without
weakening the already-enforced Workspace ceiling. Replace the hard-coded Remote adapter/create form
with a bounded Core-owned adapter/create-capability descriptor, support the same create options and
attachments as Local, and disable only an actual adapter/runtime or safe-sandbox incompatibility
with an explicit reason. Keep Desktop and Feishu on the same Core-owned relative-directory and
provider-child policy; restore provider-native hooks/plugins/MCP only when their child processes
cannot observe Worker-private or outside paths.
Keep Worker lifecycle terminal-only, do not add Worker state to Electron/preload/renderer, and do
not restart the shared development Electron, Relay, Worker, or unrelated services.

## 2026-08-06 macOS Local Worker decision ledger

- `MW-01` (confirmed, user-owned): the current Mac can act as the Local Worker; Relay itself does
  not require Codex or provider credentials.
- `MW-02` (confirmed, user-owned): Worker has one outer Workspace Sandbox and can observe only its
  contents plus exact private runtime state.
- `MW-03` (confirmed, user-owned): provider-native sandbox settings remain unchanged user choices
  and are nested children that cannot widen the outer sandbox.
- `MW-04` (confirmed, user-owned): all other Worker functionality behaves normally inside the
  outer sandbox; a reduced headless/provider feature set is not acceptable.
- `MW-05` (confirmed, project constraint): changing Local/Remote source selection never stops the
  Worker/Core or its sessions.
- `MW-06` (confirmed product constraint): macOS, Linux Relay Worker, and Linux Full expose the same
  Workspace Sandbox semantics. Platform-specific engines are an implementation detail; the design
  should use the strongest compatible adapter on each platform without changing provider-native
  sandbox controls.
- `MW-07` (confirmed, user-owned): one Relay binds one Worker and that Worker shares one Workspace
  Sandbox across its sessions. A later multi-tenant deployment uses multiple isolated Relay/Worker
  deployments rather than multiplexing tenants inside one Worker.
- `MW-08` (confirmed, user-owned): Worker state lives in a Worker-specific app-private directory,
  separate from the user-selected workspace, and only that exact private root is added to the outer
  sandbox.
- `MW-09` (confirmed, user-owned): Worker configuration and lifecycle are terminal-only. Electron
  imports Client credentials only and must not expose Worker, workspace, topology, instance, or
  Worker service state.
- `MW-10` (confirmed, user-owned): Relay issues the one Worker credential separately from any
  number of Client credentials. Each file contains one purpose-locked identity; neither role can
  be selected or upgraded by a wire payload.
- `MW-11` (confirmed, user-owned): Feishu is another owner-equivalent client surface under the
  same authoritative Workspace ceiling as Desktop. It may use only Workspace-relative directory
  references and cannot observe or operate on host paths, Worker-private state, or paths outside
  the Workspace through commands, history, pending actions, provider tools, hooks, or MCP.
- `MW-12` (confirmed, user-owned): creating a session through Local or Remote should present the
  same provider-oriented interaction. The source-specific difference is directory authority:
  Local may use its native absolute-directory picker, while Remote exposes only a Core-validated
  Workspace-relative directory selector. Remote controls are driven by the selected Core and
  adapter capabilities; an unsupported option is disabled with a reason, never hidden by silently
  replacing it with a default, never sent as an ignored field, and never executed through Local.
- `MW-13` (confirmed, user-owned): Local capability parity is required for Remote. Provider/model/
  thinking, provider-native permission/approval/session modes, supported sandbox selections,
  attachments, and existing business features must be mirrored rather than classified as expected
  Remote omissions. Capability disabling is reserved for a concrete adapter/runtime absence or a
  sandbox mode that cannot be safely intersected with the outer Workspace boundary. Missing Remote
  protocol/broker work is an open implementation item, not an accepted final degradation.

### 2026-08-06 platform spike evidence

- A short-lived Electron-as-Node process under a macOS Seatbelt profile could read and write the
  exact workspace and Worker-private roots while an adjacent canary read failed with `EPERM`.
- Applying a second, different `sandbox-exec` profile inside that process failed closed with
  `sandbox_apply: Operation not permitted`; an identical nested profile succeeded. A separately
  signed App Sandbox probe also denied the outside canary but could not apply a nested Seatbelt
  profile. Therefore the production design must not naïvely wrap the Worker and then ask each
  provider to apply an unrelated macOS Seatbelt policy.
- The installed Claude Agent SDK exposes `spawnClaudeCodeProcess` specifically for custom
  VM/container spawning, while Codex already exposes an injected app-server process starter and
  Grok has a separable ACP launch boundary. These are the correct seams for a trusted Worker sandbox
  broker to launch provider executors with a single composed policy.
- Apple documents `sandbox-exec` as deprecated and recommends App Sandbox. Production macOS work
  therefore needs a signed helper/App Sandbox and security-scoped workspace bookmark path, with a
  development-only Seatbelt adapter allowed only as a fail-closed compatibility harness.
- A non-sandboxed native broker successfully created a transient standard URL bookmark for a
  selected directory and passed it to an independently signed App Sandbox helper. The helper
  resolved the bookmark, read the workspace, and was denied an adjacent canary. This proves the
  main Electron process can retain only a canonical workspace choice and mint a fresh per-launch
  authorization without placing the entire Electron app in App Sandbox or depending on MAS-only
  Electron bookmark return values.
- The signed-helper chain was then exercised in the production-shaped order: an App Sandbox
  launcher loaded a mode-0600 bookmark from its own container, resolved the exact workspace,
  `exec`-replaced itself with an inherit-signed Worker executable, and that Worker launched an
  inherit-signed provider/system child. Workspace reads survived both boundaries, an unrelated
  user-data and `/tmp` canary were denied, and unsigned or non-inherit Worker replacements were
  killed before startup. An inherit child carrying the JIT/unsigned-executable-memory entitlements
  required by packaged provider runtimes also remained inside the same boundary. This validates
  the launcher/child signing shape; it does not yet validate nested provider-native Seatbelt
  profiles or the final notarized application bundle.
- Claude's `enableWeakerNestedSandbox` is documented for Linux/WSL only. Linux Relay Worker can use
  bubblewrap (and Full can retain Podman) under the shared contract, but macOS cannot depend on that
  nested-mode escape hatch.

## Proposed target architecture and interaction

### User interaction

1. A Relay operator first runs one `issue-worker-connection` command and transfers its mode-0600
   Worker credential only to the designated Mac/Linux Worker machine. On that machine the operator
   runs the packaged terminal command once with the credential and workspace path. The CLI persists
   an independent Worker configuration and installs/controls its launchd or systemd-user service.
   Full has no Worker credential.
2. The operator separately runs `issue-client-connection` for each desktop. A client imports only
   its own mode-0600 Client credential and names the Remote data source. It never receives the Worker
   private key and never chooses a workspace. One machine that acts as both Worker and desktop
   imports the Worker credential in a terminal and the Client credential in Electron.
3. The Electron UI never exposes or configures Worker state. It never asks for topology, workspace,
   expected instance id, credential id, Worker id, SSH private key, or `known_hosts`; it accepts only
   Client credentials. Worker configure/start/status/stop/remove remain terminal-only operations.
4. Worker lifecycle is independent from Client profile/source selection. Explicitly disconnecting
   a Client retires only that Client transport; explicitly stopping/removing the Worker retires its
   attachment while keeping or deleting durable state according to the confirmed destructive action.
   Switching Local/Remote never disconnects or stops either side.
5. Live, Pending, History, and Session Detail remain the same business surfaces. Capabilities may
   degrade explicitly while a server is incompatible, but a Remote action never falls back to a
   Local API and the UI never forks into a second Remote business page.

### Unified New Session capability contract

- One source-neutral New Session presentation consumes a source-owned view model. Local keeps the
  native absolute-directory picker; Remote replaces only that control with a Workspace-relative
  selector whose results and final value are validated authoritatively by Core.
- Remote Core publishes a bounded, exact adapter/create-capability descriptor. It identifies the
  available adapters and, per adapter, support for provider, model, thinking/effort,
  permission/approval/session mode, provider-native sandbox mode, initial attachments, and any
  other create-time option. Renderer labels and defaults may decorate this descriptor but cannot
  invent support or keep a hard-coded adapter catalog as authority.
- A Remote create request captures source/profile/Core/Worker generation plus the capability
  revision used to render the form. Core rejects stale capability revisions, unknown adapters,
  unsupported or extra option keys, invalid option values, and any directory outside the
  authoritative Workspace. No layer silently drops an option and continues with a different
  effective configuration.
- Controls supported by the selected adapter remain the same as Local: provider/model/thinking,
  Claude permission mode and sandbox choice, Codex approval policy and sandbox choice, and Grok
  session mode and sandbox choice. A control unavailable on the selected Core/adapter stays visible
  when useful, is disabled, and gives a stable reason. An adapter absent from the authoritative
  catalog is not offered.
- Initial image/file attachments must reach Local parity through an authenticated, bounded blob
  upload/reference method. Until that implementation lands the control is disabled honestly, but
  this is an open delivery gap rather than an accepted final Remote limitation. Remote never turns
  a local host path into provider-visible input or grants the Worker access to that path.
- Agent Deck-owned Browser, MCP brokerage, worktree operations, teams/tasks/issues/files/assets,
  provider diagnostics, credential administration, and replay-backed business behavior must be
  mirrored wherever Local exposes them. Their missing authenticated Remote methods/brokers keep the
  parity phase incomplete. An intermediate build may disable the entry with a reason, but cannot
  claim that absence as the target capability model or fall back to Local.
- Current implementation baseline (to be removed by this phase): the Remote form hard-codes
  Claude/Codex/Grok, sends `options: {}`, and Core rejects every non-empty create option. Runtime
  controls available only after creation do not count as creation-time parity. Grok sandbox remains
  fail-closed to `strict` until the outer/provider policy adapter supports and attests another mode.
  Grok `strict` is still writable within the selected session CWD (a Workspace-relative directory);
  it narrows reads and writes to that directory rather than making the session read-only.
- Feishu has no interactive New Session form. Its create command uses Core-owned defaults and the
  same Workspace-relative authority; it may expose only runtime changes that Core advertises and
  must never accept a host path or renderer-derived capability claim.

### Connection credential v2

- Replace the ambiguous single schema with an exact purpose-discriminated v2 union. Client
  credentials carry `purpose=client` and one `desktop-full` identity for Full or Relay. Worker
  credentials carry `purpose=worker`, topology Relay, one `relay-worker` identity, stable Worker id,
  and internal instance binding. A file can contain exactly one purpose and one private identity.
- Relay exposes separate `issue-worker-connection` and `issue-client-connection` commands. Each
  generates one Ed25519 pair server-side and atomically updates authoritative metadata, its exact
  forced-command `authorized_keys` entry, and the transfer file. Relay admits at most one active
  Worker identity but multiple independently revocable Client identities. Any partial mutation
  rolls back and zeroes private scratch material.
- Client import writes material under the Client profile-private root. The terminal Worker CLI writes
  Worker material under an independent Worker configuration/private root keyed by the internal
  Relay/Worker identity. Renderer DTOs expose only redacted Client labels and endpoint/fingerprint;
  Worker configuration never crosses preload, and internal ids, paths, and raw keys remain private.
- This is a pre-release development branch: accept only the exact v2 purpose-discriminated
  credential contract. Do not retain a v1 compatibility path or reinterpret an old ambiguous file
  as either Client or Worker identity.

### Workspace Sandbox contract

- Add one `WorkspaceSandboxSpec` with a canonical workspace root, an exact Worker-private root,
  immutable application/system runtime roots, environment/cache projections, and a provider child
  policy. No profile may add the user's home, SSH agent, container engine socket, or arbitrary
  additional directory implicitly.
- Resolve and snapshot root identity before launch, reject symlinks and unsafe permissions, and
  recheck identity at the sandbox boundary. Symlinks inside the workspace cannot escape the outer
  authorization. Missing/unmounted roots fail closed and never trigger a broader fallback.
- `HOME`, provider config/cache roots, temporary files, Core SQLite, generation state, and SSH
  material point into `userData/remote-workers/<worker-config-id>/` (0700; files 0600). Provider assets
  needed for normal operation are copied or brokered as exact snapshots into this private root;
  the Worker does not receive the source home directories.
- Provider sandbox settings remain user-selected. Their effective policy is the intersection with
  `WorkspaceSandboxSpec`: `off`/`danger-full-access` means full access only inside the outer
  workspace, workspace-write cannot escape it, and strict/read-only can only narrow it. Approval,
  permission, network, and prompt behavior remain provider-native at the product contract.
- On macOS, use a signed App Sandbox Worker helper fed fresh transient bookmarks for the workspace
  and private root. A trusted main-process broker launches Claude, Codex, and Grok executors through
  their existing injected process seams with one composed policy, avoiding two independent
  Seatbelt applications. The broker transports stdio/lifecycle only and never executes Core
  business methods.
- On Linux Relay Worker, implement the same spec with bubblewrap and a fixed minimal environment;
  package and preflight exact `bwrap`/`socat` paths and fail closed when unavailable. Full retains
  its Podman outer boundary and maps the same workspace/private/runtime roots into the container.
  Provider-native Linux child isolation may use the documented nested mode only when the outer
  boundary is independently verified.

### Full Worker functionality

- Reuse the extracted Claude/Codex/Grok adapter hosts instead of the current reduced headless
  settings. Browser, Agent Deck MCP, prompts/skills, pending decisions, worktrees, file changes,
  hooks, usage, runtime controls, and session lifecycle remain available through authenticated
  main/Worker broker ports scoped to the Worker identity and workspace.
- Extend the Remote Core protocol/view-model only for missing existing business surfaces; do not
  create Remote-only variants. Every cache, navigation entry, subscription, pending presentation,
  and action is qualified by source/profile/Core/Worker generation.
- Browser and MCP stay main-owned where they need Electron. Worker calls them through bounded,
  authenticated IPC; broker methods reject paths outside the workspace and never return host
  credentials or unrestricted filesystem handles.

## Implementation phases

1. **Shared contracts and negative fixtures** — add the purpose-discriminated v2 credential union,
   `WorkspaceSandboxSpec`, provider-policy intersection, canonical-root validation, source-private
   identity, and exact parser/serialization tests. Reject v1 credentials and preserve renderer DTO
   secrecy.
2. **Server issuance and Linux compatibility** — add separate one-shot Worker and Client issuers,
   one-Worker/many-Client authority gates, rotation/revocation-safe metadata and literal forced-command
   tests; teach the Linux Worker CLI to import only a Worker credential, add bubblewrap packaging/
   preflight, and map Full/Podman to the shared spec without changing Relay's metadata-only boundary.
3. **Terminal Worker configuration and private-state ownership** — add purpose-specific credential
   stores plus one cross-platform `agent-deck-worker configure/start/status/stop/remove` contract.
   Configure canonicalizes one workspace, creates one Worker-private root, installs a launchd or
   systemd-user service, and never routes Worker material through Electron/preload/renderer.
4. **macOS sandbox broker and Worker lifecycle** — package/sign the native bookmark launcher and
   Worker helper, keep Worker lifecycle independent of Electron source selection, wire attach/
   reconnect/generation/service shutdown with bounded barriers, and test launch/close races.
5. **Provider executor composition** — inject the broker into Claude `spawnClaudeCodeProcess`, Codex
   app-server `startProcess`, and Grok ACP launch; enforce outer/provider policy intersection and
   exact config/auth projections before constructing any provider runtime.
6. **Feature-parity adapters and New Session parity** — introduce the bounded authoritative
   adapter/create-capability descriptor, route Local and Remote through one New Session presentation,
   validate exact Remote create options and Workspace-relative directories in Core, and add
   capability-revision fencing. Then connect normal Agent Deck MCP/Browser/prompt/skill/worktree/
   hooks/pending/file-change hosts, add missing Remote protocol projections, and collapse remaining
   Remote detail rendering into shared source-neutral presentation contracts.
7. **Validation and live acceptance** — run focused adversarial suites, typecheck, full Electron
   tests, build, Linux headless/static/bash gates, sandbox canary tests, package-signing inspection,
   then a real `Mac Worker -> Relay -> Codex` session with history/events/pending/reconnect. During
   the server run, record and recheck the VLESS/Xray process, port, firewall hash, Relay restart
   count, and server resource usage; never install or run a provider on Relay.

## Required acceptance matrix

- macOS read/write Worker: workspace and private state succeed; adjacent/home/SSH/container-socket
  canaries fail; nested provider mode cannot widen; system/app runtime still launches.
- macOS restrictive provider profiles retain their native semantics inside the outer boundary:
  Claude strict and Codex read-only cannot write the workspace, while Grok strict can read/write the
  selected Workspace-relative CWD but cannot broaden into sibling/outside paths; all may write only
  their exact required provider/session state and retain normal approval/pending interaction.
- Linux Relay Worker: same credential file and workspace semantics, bwrap unavailable/tampered
  cases fail closed, reconnect preserves one authoritative generation, and Relay persists no
  business payload.
- Linux Full: exact Podman workspace/state mounts, no host engine socket, provider mode narrows the
  container boundary, and direct desktop access remains independent of Relay.
- Credential lifecycle: separate purpose-locked one-file issuances, atomic rollback, exact v2-only
  parsing, exactly one active Worker plus many Clients, independent revocation, rotation during
  in-flight work, removal cleanup, and no raw value/path in
  renderer errors or logs.
- UI/source lifecycle: Local/Remote switch during Worker startup, reconnect, active turn, pending
  prompt, and app quit; no session-id collision, stale response commit, implicit disconnect, or
  Local fallback.
- New Session parity: one shared presentation for Local and Remote; authoritative per-adapter
  enablement for every provider/model/thinking/permission/session/sandbox control and initial
  attachment flow; Remote directory choices remain Workspace-relative; only concretely unsupported
  adapter/runtime or unsafe sandbox combinations are visibly disabled; stale capability revisions
  and extra options fail closed; no hard-coded Remote adapter authority, silent option dropping,
  host-path disclosure, or Local API fallback.
- Real smoke: create a Codex session in the selected Mac workspace through Relay, modify/read a
  canary inside the workspace, prove an outside canary is denied, answer one pending request when
  available, reconnect, and recover the same session/history.

## Known risks and validation requirements

- Worker clients contain subtle ready/close/termination/generation races; preserve their bounded
  watchdog behavior and test production adapter identity separately from client state-machine tests.
- A selected linked Git worktree may contain a `.git` file whose common directory is outside the
  workspace. Validate that the effective Git metadata root is inside an explicitly authorized root;
  never widen the sandbox to an arbitrary parent repository as an implicit convenience fallback.
- Provider network controls must remain part of the policy intersection. The sandbox broker must
  preserve provider-selected proxy/domain/network restrictions and must not turn a filesystem-only
  outer profile into unrestricted host networking.
- Provider authentication, global skills, prompt assets, and configuration must be copied or
  brokered as exact immutable projections into the Worker-private root. Do not mount the user's
  entire home, `.ssh`, provider home, or package-manager cache merely to preserve feature parity.
- Application, runtime, toolchain, and dynamic-library roots allowed read-only by a platform adapter
  must be explicit, versioned, and package-audited. Homebrew or another broad user-owned prefix is
  not an acceptable implicit runtime root.
- Each Relay deployment owns exactly one independent Worker config, workspace choice, and private
  root; any number of desktop Client profiles remain separate. Supporting several Relay/Worker
  configs in one desktop does not multiplex tenants or workspaces inside one pair.
- Client Disconnect and Worker Stop/Remove are distinct actions. Local/Remote source switching never
  invokes either. Treat their state-retention/destruction wording as an acceptance-visible contract.
- Production macOS acceptance requires the signed helper, entitlements, bookmark handoff, update
  packaging, and notarization identity to be inspected together. The development Seatbelt harness
  is evidence for policy shape only and cannot be represented as the shipped security boundary.
- A type-only import can still drag a runtime module into Vite bundles when the contract owns values;
  inspect the complete dependency graph before publishing each candidate.
- Full-suite SQLite evidence must use `pnpm test` (Electron-as-Node ABI), not a system-Node run.
- The packaged runtime fixes provider binaries under `/opt/agent-deck/providers`; acceptance must
  verify their real target-architecture artifacts and must not introduce environment overrides.
- Keep all temporary JSON reports at one explicit `/tmp` path and remove only that created file.
- Re-run `git diff --check`, cached-index check, logger scan, changed-file line guard, and changelog
  structure/max-id checks after every slice.
