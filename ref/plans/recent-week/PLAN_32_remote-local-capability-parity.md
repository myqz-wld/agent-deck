---
plan_id: PLAN_32
title: Local and Remote capability and Workspace-sandbox parity
status: completed-with-external-acceptance
created_at: 2026-08-06
updated_at: 2026-08-09
completed_at: 2026-08-09
base_branch: feature/linux-remote-core-ssh-im
base_commit: 523a5b56c61178b341b9e7650a74f9569b0246a3
final_commit: 02b16ecbcf8c8d572dea5c4f5b71a12a3867dc57
merged_main_commit: a2097eea4a84c3117a823da26f2a85d6908e9d32
predecessor: ref/plans/recent-3-days/PLAN_31_linux-remote-core-foundation.md
related_changelog: CHANGELOG_578
related_review: REVIEW_217
---

# Local and Remote Capability and Workspace-Sandbox Parity

## Archive status

Local/Remote capability parity, the Workspace-bounded provider container and broker, the remaining
Remote business surfaces, and Task 5 validation/review completed on 2026-08-09. The main delivery
landed at `a0b8a9ce85b3db016abacb8c4424c814bdfe954c`; the final lifecycle residuals landed at
`02b16ecbcf8c8d572dea5c4f5b71a12a3867dc57` and were merged into `main` at
`a2097eea4a84c3117a823da26f2a85d6908e9d32`. `REVIEW_217` records PASS with no routine in-scope
follow-up.

Task 6 remains an external production-acceptance gate requiring a supported Linux host and real
Feishu/Core SSH configuration and credentials. It is not unfinished repository implementation.
The execution log below is retained as historical evidence; earlier `active` states describe the
checkpoint at which each entry was written.

## Goal

Make `Remote` feel like the same Agent Deck product as `Local`. The data source changes; the
business UI, session-creation choices, provider controls, and normal session workflows do not.
Remote paths are always relative to one operator-selected Workspace, and no Remote operation may
fall back to Local data or Local execution.

The Workspace is the immutable outer visibility ceiling for a Relay Worker or Full deployment.
The user's provider sandbox choice is presented with the same meaning as Local for the selected
session directory. When a platform/provider cannot safely stack two native sandboxes, Agent Deck
must compile one effective policy that approximates the same user-visible choice while retaining
the Workspace ceiling; it must not expose implementation layers or weaken the boundary.

## Product invariants

- The desktop exposes only `Local` and `Remote` source modes. Server topology, instance identity,
  Worker identity, Workspace host path, and credential purpose remain internal.
- Local and Remote use one New Session presentation and one source-neutral view-model.
- Remote directories are Workspace-relative tokens. The renderer never receives an absolute Worker
  or server path.
- Every Local session-creation control is mirrored for Remote: adapter, provider/gateway, model,
  thinking, permission mode, session mode, provider sandbox, Codex approval policy, initial prompt,
  and image attachments.
- Missing Remote protocol for an existing Local feature is unfinished implementation, not an
  accepted capability downgrade. A control may remain disabled only for a concrete adapter,
  runtime, platform, or provably unsafe sandbox combination, with a Core-owned reason.
- Adapter catalogs, option schemas, defaults, enablement, and revisions are authoritative in Core.
  The renderer must not hard-code Remote adapter authority or silently discard fields.
- Capabilities and actions are source/profile/Core-generation qualified. Stale descriptors,
  responses, pending presentations, and mutations fail closed.
- Source switching never starts/stops a Worker or disconnects a Remote transport. Worker lifecycle
  remains terminal/service owned.
- Worker and Client credentials remain separate purpose-locked identities. The wire payload cannot
  upgrade a Client into a Worker.
- Relay remains an opaque bounded router with metadata-only persistence, no provider execution,
  no business queue, and no compute fallback.
- Feishu uses the same authoritative Workspace and cannot see or select host paths outside it.
- Do not start, stop, restart, or kill the shared dev/Electron instance or unrelated processes.
- Do not claim real Linux, Podman, systemd, sshd, Feishu, or provider acceptance without running it.
- Every changed ordinary TS/TSX file remains below 500 split lines.

## Sandbox contract

### Two logical boundaries

1. **Workspace ceiling** — mandatory for every Remote provider process and tool child. It may see
   the Workspace, exact immutable application/runtime roots, and narrowly brokered private state;
   it may not see the Worker private root, user home, SSH material, adjacent repositories, or host
   service sockets.
2. **User-selected provider policy** — interpreted relative to the selected Workspace directory and
   allowed only to narrow the Workspace ceiling.

These are logical boundaries, not a promise that every provider supplies two native nesting
layers. The accepted execution model is now one provider-session container beneath the Worker
Workspace boundary, plus provider-native sandboxing where it composes safely. The container never
receives Worker-private state or real provider credentials. A Core-owned credential/inference
broker outside the container supplies only a session-bound, non-secret local endpoint identity.
Linux uses rootless Podman (Docker-compatible OCI semantics); macOS uses Docker Desktop/Colima when
available. A platform without the required container runtime must publish an exact disabled
capability rather than weakening the boundary.

### User-visible mapping target

| User choice | Remote effective semantics |
|---|---|
| Provider sandbox off / danger-full-access | Full read/write inside the session container's Workspace mount only; never host-wide access |
| Workspace / workspace-write | Read the Workspace; write the selected session directory and exact brokered provider state |
| Read-only | Read allowed Workspace content; no Workspace writes |
| Strict | Preserve provider-native strict semantics inside the selected directory without widening the Workspace ceiling |
| Custom profile | Admit only when its effective policy can be bounded and verified; otherwise disable with a Core-owned reason |

Provider-specific semantics remain honest: Claude strict and Codex read-only stay non-writing when
their Local modes are non-writing; Grok strict retains read/write access to the selected directory
but cannot read/write siblings outside the effective allowance or escape the Workspace. Required
auth/config/session state is copied or brokered as exact private projections rather than exposing
an entire provider home.

## Delivered baseline

- Local/Remote source selection reuses the Live, History, Pending, and Session Detail shells.
- Direct Server Core SSH and Relay + one Worker/many Clients are implemented with exact surface and
  credential binding, bounded transport, reconnect, revocation, pending authority, and shutdown.
- v2 Client and Worker credentials are purpose-discriminated; Worker configuration is terminal-only.
- One Relay binds one Worker and one Workspace/private root. Additional tenants use independent
  Relay/Worker deployments.
- Workspace-relative project/session paths and Feishu's bounded session console are implemented.
- A real macOS Worker -> Relay -> Codex smoke created and recovered a session, proved an inside
  Workspace write/read, and denied an outside canary.
- The foundation was committed at `da3293ac2de2dce0b366d946ba5ec70097268721` and the latest
  `origin/main` (`30fd1c98eaeed829af82dddef5f295489ce42871`) was merged at
  `523a5b56c61178b341b9e7650a74f9569b0246a3`.
- The merge passed 69 focused tests, typecheck/architecture checks, production build, bundled Grok
  verification, and `git diff --check`.

## Current gaps

1. Task 4's Remote Browser, MCP collaboration, handoff, worktree, plan presentation/companion,
   assets, issues, hooks, task/activity, summary, and bounded diff projections are implemented. The
   remaining work is Task 5 whole-tree validation and heterogeneous security/lifecycle review.
2. The Provider container/broker vertical slice is complete: exact topology-free contracts,
   host-owned lifecycle supervisor and private transport, production OCI adapter, canonical mount
   authority, Unix HTTP and attach-stdio inference transports, trusted upstream credential
   injection, fixed shim/image, Grok adapter wiring, and dynamic capability publication are tested.
3. Grok is no longer permanently Core-disabled. It and its Local-equivalent sandbox choices are
   available when the supervisor, pinned image, and broker credential are ready; any missing
   component disables only Grok with an exact reason. The fixed negative gate still prohibits the
   rejected same-process `$GROK_HOME`/`auth.json` design.
4. Real macOS Colima acceptance now covers the production-shaped container, pinned Grok 0.2.118,
   ACP prompt, exact Chat Completions and Responses broker routes, Core-side credential injection,
   a real model-issued Workspace file tool, read-only and adjacent-root denials, OCI hardening, and
   teardown using a deterministic dummy upstream. Signed/notarized packaged-app acceptance remains
   separate.
5. Real Full Podman/Quadlet/systemd/sshd, Linux Relay Worker, and live Feishu acceptance remain
   external gates for Task 6.

## Decision ledger

- **D1 — Local parity is the default:** confirmed by the user. Remote is not a reduced product.
- **D2 — Directory meaning:** Remote chooses the Workspace root or a relative subdirectory; no
  absolute path crosses to the renderer.
- **D3 — Sandbox UX parity:** the user chooses the same provider sandbox concepts as Local, applied
  to the selected directory under the immutable Workspace ceiling.
- **D4 — One effective layer is acceptable:** if two kernel sandboxes cannot compose, compile one
  policy with equivalent visible behavior and no weaker boundary.
- **D5 — Capability disablement is exceptional:** only concrete runtime/platform incompatibility or
  unsafe policy composition may disable an item. Missing protocol is work to implement.
- **D6 — Worker is terminal-only:** no Worker setup, role, Workspace, topology, or instance control
  is added to the desktop business UI.
- **D7 — Pre-release contracts may change:** no backwards-compatibility layer is required for the
  unreleased credential/create protocols; migrate the development state directly.
- **D8 — Execution signal:** the user explicitly started the next phase on 2026-08-07. Work begins
  with the capability contract before dependent UI and sandbox tasks.
- **D9 — Container/broker boundary:** confirmed by the user on 2026-08-08. Claude Code, Codex CLI,
  and Grok Build run with Local-equivalent selectable sandbox concepts inside a session container.
  The container receives only the selected Workspace mount and runtime artifacts; it receives no
  Worker-private directory, SSH identity, provider auth file, engine socket, or reusable provider
  token. Core owns the real credential and a bounded inference broker. Full and Linux Relay use
  rootless Podman; macOS Relay uses Docker Desktop/Colima when present and otherwise disables the
  container-dependent provider choices with a Core-owned reason.

## Task chain

Tasks 1-5 are complete. Task 6 remains an external acceptance gate behind the required production
environment and credentials.

1. `bdfe8d37-89ed-4add-96dc-cea56280e4ba` — Define authoritative Remote adapter and creation capabilities. **Completed 2026-08-07.**
2. `87fef53a-73ea-480e-8db5-bada1f2d9efc` — Mirror Local New Session through Remote Core. **Completed 2026-08-07.**
3. `674f0dba-cbb1-45c4-abe3-ca2a1305d490` — Compile Workspace-bounded provider sandbox parity. **Completed 2026-08-07.**
4. `cd474e60-b284-4ad7-b07a-b8dd1ff218d9` — Restore Remote Browser/MCP/worktree/business parity and implement the provider container/broker boundary. **Completed 2026-08-08.**
5. `d3b25e9c-eb86-42c6-8e33-2beb193fc926` — Validate and review parity across topologies. **Completed 2026-08-09.**
6. `eb83b64b-607b-4feb-9f3b-9863860d3373` — Run real Full and Feishu acceptance. **External environment gate.**

## Execution route

### Phase 1 — Capability and creation contract

- Publish an exact, versioned adapter/create descriptor from Core.
- Include defaults, allowed values, disable reasons, option schema, attachment policy, directory
  policy, sandbox semantics, and capability revision.
- Make create validate the complete option set and reject extra/stale/unsupported inputs.
- Add Local/Remote contract parity and adversarial serialization fixtures before UI wiring.

### Phase 2 — Shared New Session vertical slice

- Extract one presentation/view-model used by both sources.
- Local keeps native absolute-directory selection internally; Remote supplies Workspace-relative
  choices only.
- Send all selected controls and attachments to the source-specific adapter without UI branching or
  Local fallback.
- Preserve source/profile/Core-generation and capability-revision fences across dialog refresh,
  create, retry, and source switch.

### Phase 3 — Effective sandbox compiler

- Define one provider-neutral policy IR and platform/provider compilers.
- Validate canonical Workspace/cwd/private-state identities before any child spawn.
- Implement exact immutable projections for provider credentials/config/session state.
- Launch provider sessions through an OCI boundary with an exact Workspace mount, no engine socket,
  no private-root mount, fixed image/binary identity, bounded resources, and bounded teardown.
- Keep real provider credentials in Core and give the container only a session-bound broker
  endpoint/identity that is useless outside the exact instance, provider, and session lifetime.
- Prove every child/tool subprocess inherits an equal-or-narrower policy.
- Add outside-Workspace, sibling-directory, private-root, symlink, Git metadata, socket, dylib, and
  network-policy canaries for macOS, Linux Relay Worker, and Full.

### Phase 4 — Remaining business parity

- Add bounded authenticated Remote broker/method surfaces for Browser, MCP, worktree, file changes,
  tasks, issues, assets, hooks, summaries, and remaining detail actions.
- Reuse shared presentation contracts and preserve explicit capability reasons only where a real
  backend limitation remains.
- Ensure Feishu observes the same Workspace ceiling and never becomes a path or privilege bypass.

### Phase 5 — Validation and release evidence

- Run focused contracts, source switching, pending, lifecycle, reconnect, credentials, and sandbox
  race suites.
- Run `pnpm typecheck`, full Electron-ABI tests, production build, Linux/macOS package/static gates,
  whitespace/record/line guards, and heterogeneous deep review.
- Run real macOS and Linux Relay Worker sessions for Claude, Codex, and Grok where available.
- Separately run real Full and Feishu acceptance when the required host/credentials exist.

## Validation matrix

- Same New Session choices and defaults appear for Local and Remote from authoritative descriptors.
- The same option set produces equivalent runtime state, subject only to a visible concrete disable
  reason.
- Remote create rejects absolute/traversal/symlink-escape directories, stale capability revisions,
  extra fields, invalid attachments, and unsupported adapter combinations.
- Local and Remote may reuse the same raw session/request IDs without cache, action, pending, or
  navigation crossover.
- Switching source/profile/Core generation during list/detail/create/pending/runtime operations
  cannot commit a stale result and cannot stop the Worker.
- Every sandbox mode satisfies its Workspace/cwd write matrix and denies adjacent/home/private-root/
  SSH/service-socket canaries.
- Provider-native tool children and MCP/browser/worktree brokers cannot widen the effective policy.
- Relay contains no provider, business persistence, or fallback compute after the parity additions.
- Full and Feishu limitations remain documented as evidence boundaries until live acceptance passes.

## Risks

- Provider-native sandbox names do not have identical semantics. UI labels must map to an explicit
  effective policy rather than pretending the implementations are byte-equivalent.
- Linked Git worktrees may reference metadata outside the Workspace. Never authorize an arbitrary
  parent repository implicitly; require an explicit bounded projection or disable the operation.
- Broad runtime roots such as a user-owned Homebrew prefix are not acceptable implicit read grants.
- Credentials/config copied into private projections require rotation, revocation, cleanup, and
  zeroization without exposing the Worker private root to provider tools.
- Creation retries need stable intent idempotency so a deadline after commit cannot duplicate a
  session or initial message.
- Capability descriptors must be bounded and revisioned; otherwise reconnect or runtime upgrades
  can enable stale controls or silently change create semantics.

## Final state and handoff

- Status: `completed-with-external-acceptance`; tasks 1-5 are complete.
- Git: the final feature HEAD is `02b16ecb`; `main` contains it through merge `a2097eea`.
- Tasks: tasks 1-5 are complete; task 6 is an external production-acceptance gate.
- Processes: no shared dev/Electron/VLESS/remote service was restarted, stopped, or killed.
- Safe checkpoint: `.grok/auth.json` remains purged from the provider home and the fixed negative
  gate still proves why it may not return. Grok now authenticates through the Core-owned broker;
  the Provider container receives only a dummy marker and one session-bound inference transport.
- Completed boundary slice: public DTOs contain only relative Workspace refs and opaque identities.
  Host-private code owns canonical mount identities, digest-pinned OCI commands, resource/lifecycle
  fences, private supervisor transport, and exact teardown. Core owns endpoint identity, a trusted
  multi-profile upstream catalog, credential injection, byte/concurrency/deadline limits, and
  cancellation without returning credentials.
- Live checkpoint: Colima 0.10.3 and Docker CLI 29.7.2 were installed with user authorization. The
  immutable arm64 acceptance image
  `sha256:22c027894850e8a5f69154f6d46cb08ac09dc867772cdc8bc9e88f4959c0211e`, built from the
  current recipe image plus the current Provider-session bundle, passed the opt-in real Grok
  ACP/session/prompt gate. The real pinned Grok 0.2.118 used exact Chat Completions and Responses
  routes, accepted an actual `allow_once` file-tool decision, wrote a host-visible Workspace
  canary, failed to write through the read-only mount, failed to read an adjacent-root canary, and
  left no managed container. This is macOS Desktop-VM evidence only, with a deterministic dummy
  Core upstream and no billable xAI request.
- Validation checkpoint: the authoritative Electron-ABI suite passed 852 files / 5,489 tests with
  two intentional file skips and three intentional test skips. Typecheck and both architecture
  gates, production build, Linux headless, Full/Relay/Manager/Feishu static checks, bundled-runtime/
  Grok negative, and macOS Worker sandbox gates passed. Every changed ordinary TypeScript/TSX file
  is below 500 lines, and no managed acceptance container remains.
- Current action: no in-scope implementation action remains. Preserve the Linux/Full/Feishu
  live-host evidence limits until Task 6 is run in the required external environment.

## Progress log

### 2026-08-07 — Task 1 complete

- Added `session.console.capabilities` with exact schema versioning, adapter summaries, option
  catalogs/defaults, sandbox semantics, attachment/directory policy, and SHA-256 capability
  revision.
- `session.console.create` now requires the complete nine-field option object and the captured
  capability revision; Core rejects stale, cross-adapter, unavailable-provider, and widened input.
- Server Core, Electron main/preload/IPC, renderer compatibility path, and Feishu `/create` consume
  the same descriptor without receiving absolute Workspace/provider paths.
- Validation passed: 51 focused Electron-runner files / 308 tests, typecheck and both architecture
  checks, production build, `git diff --check`, and ordinary changed TS/TSX files below 500 lines.

### 2026-08-07 — Task 2 complete

- Local and Remote now render one New Session form. Remote adapter/provider/model/thinking,
  permission/session mode, approval, sandbox, and attachment controls come from the Core-owned
  revisioned descriptor; Local continues to use its existing native source adapters.
- Added the desktop-only `workspace.directory.list` contract and a canonical Core directory
  catalog. The picker receives relative direct children only and rejects files, symlinks, escapes,
  unsafe names, stale source identities, and absolute host-path disclosure.
- Remote create carries exact options, capability revision, initial images, and stable intent
  identity. Inline images are bounded below the 4 MiB transport frame, persisted to private
  quota-bound Core storage, and content-digested before renderer idempotency keying.
- Source/profile/Core-generation fences cover descriptor reads, directory browsing, create
  responses, retries, and dialog switches; no Remote action falls through to a Local API.
- Validation passed: 66 related files / 372 tests, full Electron suite 785 files / 5,220 tests plus
  one existing skip, typecheck and architecture checks, production build, and all changed TS/TSX
  files below 500 lines.

### 2026-08-07 — Task 3 complete

- Added one provider-neutral policy compiler with canonical Workspace/cwd/private-root identities,
  selected-directory and Workspace read/write semantics, private-state denial, TOCTOU rechecks, and
  rejection of every additional Remote write root.
- Claude now receives a fail-if-unavailable native policy plus managed hook/MCP/plugin lockdown;
  Codex receives fixed process-installed permission profiles selected again at every thread/turn.
- Provider processes use exact private HOME/cache/state/temp roots. Only Claude OAuth and Codex auth
  files are projected with mode/owner/identity checks; stale or retired Grok credentials are purged.
- Remote Grok is Core-disabled with a concrete reason because native strict exposes `$GROK_HOME` to
  tool subprocesses. This is the D5 unsafe-composition exception, not silent reduced parity; Task 4
  owns the private authentication broker required before Grok can be re-enabled.
- Focused Electron tests, typecheck/architecture, Full static checks, Linux headless verification,
  and the signed macOS Worker/provider outside-Workspace canary passed. Real Linux/Full/live-provider
  acceptance remains in Tasks 5-6.
- Final closure passed 786 Electron-runner files plus one skip and 5,229 tests plus one skip,
  production build, and repeat typecheck/architecture. The initial Remote capability load now
  adopts the Core-selected adapter without issuing a duplicate request or transiently disabling
  the shared New Session controls.

### 2026-08-07 — Task 4 partial: summaries and bounded text file changes

- Added exact desktop-only Core methods for summary records, file-change pages/payloads, and final
  diffs. Server Core rechecks the session under Workspace, projects every structured path to a
  relative token, bounds content/metadata/diffs, and rejects Feishu access to these detail methods.
- The Remote detail shell now reuses the shared Summary presentation and Diff tab machinery. All
  reads remain profile/Core-generation qualified and go through Remote IPC; missing capabilities
  render an explicit unavailable reason and never fall through to Local file APIs.
- Image change rows stay hidden until the authenticated Remote asset broker exists, preventing the
  existing Local image loader from receiving or resolving Worker paths. Text changes and final
  diffs are usable without exposing the Workspace host path.
- Moved file-change read diagnostics behind a Core-safe port so the headless Server Core package
  does not import Electron logging. Architecture checks and both TypeScript projects pass; the
  focused Electron-ABI closure passed 38 files and 201 tests. Task 4 remains active for events,
  tasks/issues, Browser/MCP/worktree/assets/hooks, and Grok authentication brokerage.

### 2026-08-08 — Provider container and credential-broker decision

- Rejected the attempted Grok-only `$GROK_HOME` projection using the pinned Grok 0.2.118 binary:
  native strict without an explicit deny allowed a model-issued read tool to recover a dummy cached
  credential, while denying that exact `auth.json` caused Grok's own authentication to fail.
- The user approved an OCI provider-session boundary plus a Core-owned credential/inference broker.
  This makes Local-equivalent sandbox choices relative to the Workspace mount while keeping all
  reusable credentials and Worker-private state outside the model/tool execution environment.
- Full and Linux Relay target rootless Podman. macOS Relay targets Docker Desktop/Colima; missing or
  unverifiable runtimes fail closed through the capability descriptor. Docker/Podman alone is not
  treated as credential isolation, and no secret mount or engine socket is admitted.

### 2026-08-08 — Safe handoff checkpoint

- Removed the rejected same-process Grok auth projection, managed-profile injection, and adapter
  spawn overrides. Grok remains Core-disabled with Local-equivalent `read-only`, `workspace`, and
  `off` choices visible only as disabled, all carrying the container/broker requirement.
- Added a fixed-binary negative compatibility gate using dummy credentials only. It proves both
  halves of the incompatibility: without an auth deny the model tool reads the canary; with the
  auth deny the same Grok process cannot authenticate and start.
- Focused Electron validation passed 8 files / 33 tests. Typecheck, both architecture gates, and the
  fixed-binary negative gate pass. No process was stopped or restarted, and the Git index remains
  empty.
- No Provider container or inference-broker implementation exists yet. That is the first new-code
  boundary for the successor; do not re-enable Grok from an auth file or native profile alone.

### 2026-08-08 — Task 4 partial: Provider container supervisor and inference broker boundary

- Added exact versioned contracts for Provider session launch/stop/readiness and bounded inference
  request/response. They accept only Workspace-relative directories, fixed adapter/runtime/resource
  identities, opaque endpoint handles, one upstream-relative HTTP path, and bounded JSON/SSE data;
  image, mount, environment, credential, full URL, engine socket, and host path fields are rejected.
- Added a Core-facing supervisor port physically separated from host-private OCI types. The host
  supervisor reserves process/session identity, requires rootless-user or desktop-VM boundary
  attestation, fixes digest image and non-root/no-network/resource-limited commands, revalidates
  mounts around create/start, and destructively stops/removes only an exact inspected container.
- Added a canonical Node mount authority that derives the selected directory and broker socket from
  fixed roots, creates one exclusive non-secret session-state tree, records inode/owner/mode/socket
  identity, detects replacement, and removes only that exact tree without following model-created
  symlinks.
- Added the Core session-bound inference broker. It binds instance/process/session/adapter/provider/
  upstream/method/path, applies per-endpoint and global concurrency plus request/response byte and
  deadline limits, aborts work on deadline/release/close, retains identity until in-flight work
  retires, and delegates credential lookup/injection to a trusted upstream port whose input has no
  auth field.
- Closed two full-suite integration regressions without weakening the boundary. Remote service
  shutdown now starts desktop-broker and SSH transport cleanup concurrently, so a blocked broker
  cannot delay local transport retirement. The API classification gate now distinguishes the
  memory-only, request-bound `desktop.broker.respond` mutation from durable replay/idempotency
  mutations, keeping Browser response bodies out of Core replay storage.
- The slice passed 9 focused Electron files / 57 tests, repeat 5-file boundary closure / 33 tests,
  typecheck and both architecture gates, Linux headless build/package isolation, Full static checks,
  `git diff --check`, and the fixed Grok negative gate. A pre-existing 507-line MCP integration test
  was mechanically split to 482+31 lines to restore the package line guard.
- Final integration closure passed 830 test files / 5,399 tests with one intentional skip, repeat
  typecheck and both architecture gates, and the main/preload/renderer production build.
- No production engine command adapter, Core-to-host supervisor transport, broker Unix HTTP server,
  real upstream credential injector, provider-session shim/image, or adapter wiring exists yet.
  Remote Grok and its Local-equivalent sandbox choices therefore remain explicitly disabled.

### 2026-08-07 — Task 4 partial: task reads and bounded activity events

- Added exact desktop-only `session.tasks.list` and `session.events.list` methods. Task reads use a
  Core-safe read repository with personal/active-team visibility; event pages enforce item,
  JSON-depth/node, per-payload, and aggregate byte ceilings.
- Server Core rechecks the session under Workspace, binds the authoritative adapter identity,
  projects structured paths to `Workspace`, redacts private roots, hides outside-Workspace paths,
  and removes attachment/binary fields before returning activity records.
- Local and Remote now share task and activity presentations. Remote approval events are read-only
  in Activity and remain actionable only through Remote Pending; Remote image rows cannot call
  Local upload or image-blob IPC while the asset broker is unavailable.
- Split read-only Remote detail methods behind one service reader without weakening capability,
  deadline, source/profile/Core-generation, or client-identity fences. Broad Electron validation
  passed 70 files / 380 tests, and typecheck plus both architecture gates passed. Task 4 remains
  active for mutations, issues, Browser/MCP/worktree/hooks/assets, and Grok authentication.

### 2026-08-07 — Task 4 partial: Remote Issues board and mutations

- Added exact desktop-only Issue list/get/update/soft-delete/undelete contracts backed by the
  authoritative Core database. Core projects Workspace-relative paths, redacts private roots,
  bounds evidence, and requires revision plus stable idempotency identity for mutations.
- Local and Remote now use the same Issue board, filters, rows, detail editor, evidence display, and
  delete/restore controls. Remote state remains source-qualified, does not enter the Local store,
  and cannot fall through to Local IPC.
- The renderer retains the Core revision from both list and detail reads, rebases edits over data
  refreshes, reuses intent identity after ambiguous deadlines, and fences late results on source/
  profile/Core-generation changes.
- Focused validation passed 6 files / 21 tests; the broad Electron-ABI run passed 61 files / 298
  tests, and typecheck, both architecture gates, production build, and Linux headless artifact
  verification passed. Atomic resolution-session binding, Browser/MCP/worktree/hooks/assets, image
  payloads, and Grok authentication remain active Task 4 work.

### 2026-08-07 — Task 4 partial: Core session collaboration MCP

- Extended the private per-session Core MCP host with Local-equivalent session listing/detail,
  bounded activity reads, durable cross-session messaging, and targeted shutdown tools.
- Session visibility follows spawn/team/handoff relations by default, explicit spawn recovery stays
  available, cwd is Workspace-relative, and event projections redact private/outside/binary data.
- Messages use the authoritative SQLite state machine and real provider adapter ingress with bounded
  dispatch, rate limits, delivery-time team/reply checks, and at-most-once ambiguous terminalization.
- Typecheck/architecture and repository/runtime/MCP collaboration tests passed. `spawn_session`,
  handoff, presentation, and worktree tools remain active Task 4 work.

### 2026-08-07 — Task 4 partial: Remote image asset broker

- Image file-change rows now expose opaque change/side handles and reuse the shared Diff viewer.
  Remote images never call Local image IPC and cache keys include the Remote source identity.
- Core authoritatively rebinds each handle to the selected session, permits only canonical image
  files inside Workspace, rejects symlink escapes, reads through one fd, caps assets at 16 MiB, and
  streams identity-fenced 512 KiB chunks without returning Worker paths.
- Exact main/preload/IPC validation and profile/Core-generation fencing assemble the data URL on the
  desktop side. Focused tests passed and the broad canonical run passed 75 files / 388 tests;
  typecheck, both architecture gates, and `git diff --check` passed.
- Task 4 remains active for Browser, worktree, remaining MCP/presentation tools, hooks, and private
  Grok authentication brokerage.

### 2026-08-07 — Task 4 partial: Remote Core worktree lifecycle

- Added `enter_worktree` and `exit_worktree` to the private Core MCP host using the durable Local
  transition/input repositories with Core-owned adapter, event, recovery, and cleanup ports.
- Claude, Codex, and Grok now feed provider tool/turn events and incoming messages through the same
  automatic cwd-transition fence. Buffered user input resumes only after the exact tool result,
  expected interruption, authoritative cwd persistence, and continuation delivery.
- Public inputs and results use Workspace-relative paths only. Git common-dir identity, detached
  commit, symlink/private-root bounds, clean state, durable HEAD, active session references, and
  concurrent leases are revalidated before mutation or cleanup.
- A real temporary Git repository passed the complete enter/switch/replay/exit/remove lifecycle;
  focused canonical tests passed 4 files / 14 tests, and typecheck plus architecture gates passed.
- Task 4 remains active for Browser, presentation/handoff MCP, hooks, and private Grok
  authentication brokerage.

### 2026-08-07 — Task 4 partial: Remote desktop Browser broker

- Added all fourteen Browser MCP tools to the private Core session host and routed them through a
  bounded memory-only broker to the exact authenticated desktop client owning the Remote session.
- Electron main reuses the existing Browser handlers under source/profile/Core-generation/session
  ownership. Session close, disconnect, Core-generation replacement, and service shutdown dispose
  owned tabs; switching Local/Remote source mode does not stop the broker or transport.
- Remote navigation rejects `file://`; screenshots return only bounded inline PNG content and
  remove desktop temp artifacts. No desktop path, Worker-private path, or topology identity crosses
  the protocol, and Feishu cannot claim the desktop Browser queue.
- Focused canonical tests passed 10 files / 38 tests. Typecheck, architecture gates, production
  build, Linux headless build/package isolation, and `git diff --check` passed.
- Task 4 remains active for presentation/handoff MCP, hooks parity, and private Grok authentication
  brokerage.

### 2026-08-07 — Task 4 partial: Remote Core user presentations

- Added exact bounded `present_plan` and `present_diff` contracts and a memory-only Core service.
  The MCP call blocks on a Core-owned presentation that is merged into authoritative
  `pending.list`; responses reuse the existing revision-fenced `pending.respond` path.
- Local and Remote now share `ExitPlanRow` and `DiffReviewRow`. The renderer submits the revision
  captured with the presentation, and main rereads current Core state before accepting a decision
  or revision feedback.
- Remote plan deep review is explicitly disabled with a concrete Core-owned-companion reason; it
  never falls through to the Local reviewer path. That companion flow remains active Task 4 work.
- Focused canonical validation passed 11 files / 67 tests. Typecheck and both architecture gates
  passed. Task 4 remains active for handoff, hooks parity, Remote plan companion review, and private
  Grok authentication brokerage.

### 2026-08-08 — Task 4 complete: handoff, hooks, review companion, and Provider Grok

- Completed Core-native handoff with bounded continuation capture, trusted target selection,
  queued/late-message cutover, strict successor rollback, and atomic worktree/team/presentation
  ownership transfer. Completed managed Core hook installation and Remote plan companion review
  without Local fallback or Feishu authority.
- Completed the production Provider path: private Core-to-host supervisor transport, Docker
  Desktop/Colima and rootless-Podman OCI adapter, exact host config/service, Unix HTTP inference
  endpoint, attach-stdio multiplexer, trusted route/credential upstream, fixed container shim/image,
  and Grok process/capability wiring. Engine authority remains outside Worker and Full Core.
- The broker is profile-extensible rather than Chat Completions-global: trusted profiles bind an
  adapter/provider/upstream to fixed path-specific HTTPS origins, credentials, and limits. The
  current Grok profile admits exactly xAI Chat Completions and Responses; the shim answers only the
  fixed local `GET /v1/models` catalog needed by pinned Grok. Tests independently admit Claude
  Messages and OpenAI Responses profiles while rejecting path/origin/header substitution.
- The opt-in Colima acceptance ran real Grok 0.2.118 through ACP authentication, `session/new`, and
  `session/prompt`. Only the Core-side fake upstream observed the dummy canary; the request body,
  inspected container, Workspace mount, and provider state did not. OCI resource/capability/network
  fences passed and exact teardown left no managed test container.
- Focused Provider closure passed 22 tests plus typecheck and both architecture gates; handoff,
  hooks, and plan companion closure passed 34 Node-compatible tests, with SQLite-backed cases left
  to the Electron-ABI/full-suite Task 5 run. Task 4 is complete and Task 5 is active.

### 2026-08-08 — Task 5 pre-review validation

- The authoritative Electron-as-Node suite passed 847 files / 5,458 tests with two intentional
  file/test skips. Its first two runs exposed one test-harness-only attachment timeout: the test
  stripped `ELECTRON_RUN_AS_NODE` and therefore relaunched the Electron binary as an app. The test
  injection now preserves that harness flag without admitting it to the production environment;
  focused Electron and ordinary Node runs both pass, while production termination bounds remain
  unchanged.
- Mechanically extracted three shared test fixtures so every changed ordinary TypeScript/TSX file
  is below 500 lines. The affected 3 files / 42 tests and repeat typecheck/architecture gates pass.
- Production build, Linux headless, Full static packaging, bundled Grok plus the fixed negative
  gate, and the signed macOS Worker sandbox gate pass. The live Colima acceptance left no managed
  container, and the exact non-secret manual debug state created by this task was removed after
  identity and ownership verification.
- Task 5 remains active until the required user-confirmed heterogeneous deep review completes.

### Task 5 heterogeneous deep-review manifest — `rlp-task5-20260808-01`

- Review type: mixed code/plan, iterative review-and-fix.
- Baseline: working tree at HEAD `a7bcebc1b5da49f46b6820cab862f96faf719b67`; index empty.
- Confirmed pair: `reviewer-claude` using gateway `deepseek`, model
  `deepseek-v4-flash[1m]`, thinking `max`; and `reviewer-codex` using its inherited/default Codex
  runtime. Every pair receives the same exact scope and must keep source/index/commits unchanged.
- Exact scope capture: all 420 tracked-change/deletion and untracked file paths present at invocation
  start belong to exactly one primary batch. Worker prompts carry the absolute per-batch path list.

| batch_id | kind | exact paths | dependencies | state |
|---|---|---:|---|---|
| `provider-boundary` | primary | 92 | none | active |
| `remote-core-contracts` | primary | 120 | none | active |
| `remote-renderer-ui` | primary | 60 | `remote-core-contracts` | active |
| `collaboration-lifecycle` | primary | 70 | none | active |
| `topology-packaging-records` | primary | 78 | none | active |
| `cross-boundary-integration` | integration | 28 | all five primary batches | queued |

Round 1 required both workers to read every listed path in their batch and check correctness,
regressions, tests, and design-to-code consistency; all five pairs completed that coverage and the
rebuttal phase. Round 2 retains these stable batch ids and will pressure-test the applied fixes,
races, resource lifecycle, invariant enforcement, architecture coupling, security, and residuals.
The integration pair remains queued until the primary Round 2 batches converge.

### 2026-08-08 — Task 5 Round 1 adjudication and fixes

- Both selected reviewers completed all five primary scopes and their required rebuttals. No
  unreadable path remained. Every accepted HIGH/MEDIUM finding below had either independent paired
  support or a bounded lead-side reproduction; routine fixes are applied and await Round 2.
- Provider lifecycle fixes now retain concurrency and endpoint identity until the credential-bearing
  upstream promise retires, tolerate bounded late cancellation through retired-id tombstones,
  reject ambient provider/cloud credentials through an explicit process environment allowlist,
  quarantine ambiguously accepted OCI creates until identity reconciliation, and preserve exact
  response/session/path identity across broker, multiplex, and container boundaries.
- Grok production routing now binds one trusted `grok-xai` profile to exactly
  `/v1/chat/completions` and `/v1/responses`, each with its Core-owned origin and credential
  injection. The container cannot choose an origin or authorization header. The fixed local model
  catalog is not a credentialed upstream route. Claude Messages and OpenAI Responses remain
  independently covered generic profiles rather than being forced through a Grok/Chat contract.
- Core and Browser fixes made create replay precede changing capability validation, closed
  post-create attachment/session ambiguity, redacted absolute/private paths from detail payloads,
  bound targeted results and image chunks to requested identities/offsets, and replaced cross-host
  wall-clock expiry with a Core-owned relative Browser lease and bounded owner re-election.
- Renderer fixes clear task records on target change, qualify retained intents by source, isolate
  optional detail failures, stabilize diff readers across unrelated renders, prevent busy
  plan/diff decisions from being acknowledged locally, and keep Issue revisions monotonic.
- Collaboration fixes validate the nearest existing worktree ancestor before any directory
  creation, hold a Core-owned path fence across session registration and destructive cleanup,
  preflight the exact `.agent-deck/` ignore entry, reject archived MCP callers, validate transferred
  presentation identities, and warn against blind task-create retry after ambiguous storage.
- Topology closure ships explicit Linux systemd-user and macOS LaunchAgent supervisor templates,
  derives short instance-scoped roots, packages the supervisor assets, and extends static/package
  gates so stock Full/Relay documentation no longer names an unprovisionable lifecycle.
- Accepted residuals remain non-blocking and explicit: the handoff post-commit crash window, Remote
  native-history fork parity, and same-source renderer intent saturation are LOW/backlog items;
  live rootless-Podman, Linux Relay, Full, Feishu, and signed/notarized-package acceptance remain
  Task 6 evidence gates rather than claims made by this macOS Colima run.
- Final Round 1 fixed-state validation passed 852 Electron-ABI test files / 5,489 tests with two
  intentional file skips and three intentional test skips; repeat typecheck and both architecture
  gates; production main/preload/renderer build; Linux headless build/package checks;
  Full/Relay/Manager/Feishu static checks; bundled Grok plus its fixed negative gate; and the signed
  macOS Worker sandbox canary. A mechanical pending-hydrator extraction left the source hook at 495
  lines and its test at 498; the affected 7 renderer files / 35 tests pass.

### 2026-08-09 — Task 5 complete and archive handoff

- The required heterogeneous review rounds converged to COMPLETE/PASS. All accepted findings were
  fixed, and `REVIEW_217_remote-parity-finalization.md` records no remaining routine in-scope item.
- Final validation passed 860 Electron-ABI files with two designed skips and 5,610 tests with three
  designed skips, the 22-file / 89-test focused collaboration batch, typecheck and architecture
  gates, production and Linux-headless builds, deployment static checks, diff checks, and the
  changed-file size guard.
- The feature branch was merged into `main` at `a2097eea`. Real supported-Linux Full/Relay and live
  Feishu acceptance remain explicitly external evidence gates and are not claimed by this archive.
