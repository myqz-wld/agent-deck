# P0 Cleanup and Compatibility Audit Batch

Status: complete and accepted; Batch 1 evidence manifest and lead-owned Batch 2 cleanup validated
Parent plan: [`PLAN_38_feishu-one-click-server.md`](../PLAN_38_feishu-one-click-server.md)
Planning base commit: `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222`
User authorization already established: include this work as P0 and prepare it for parallel execution
Batch 1 envelope approval recorded: approved through the P0 plan gate at `2026-08-13T17:48:01Z`; valid only for the unchanged envelopes below. The complete parent implementation plan was approved on `2026-08-13`, and the managed isolated worktree is active at `/Users/wanglidong/Repository/agent-deck/.agent-deck/worktrees/agent-deck-019ffbfd-37c-msrtkmb2` on branch `codex/feishu-one-click-server`.

## P0 Objective

Remove code that exists only for already-removed Team and session-permissions pages, and independently audit the repository for compatibility code that no longer protects a supported artifact, upgrade path, persisted datum, provider shape, or external contract. Finish P0 before topology, access-policy, Server CLI, or Feishu implementation so the new policy is built from the current product rather than dead surfaces.

P0 is not authorization to remove all code containing `legacy`, `compatibility`, old schema numbers, or Team/permission terminology.

## Post-P0 Clean-Break Addendum — Superseding User Decision

On `2026-08-13`, after P0 completed, the user explicitly established that Agent Deck has not been formally released and no historical Agent Deck compatibility must be preserved. This supersedes the support-window assumptions used by the P0-B retain table; it does not invalidate the audit evidence or authorize blind string-based deletion.

- T1 removes the now-unneeded compatibility readers for connection credentials, Remote profiles, bridge admission, Relay route metadata, protocol-minor negotiation, Feishu/Full configuration, and Feishu/Full metadata databases. Retired inputs fail closed without mutation; operators recreate pre-release artifacts.
- A new T1.5 task, `c0828fa5-616b-4b6d-aedc-50b5819a6a82`, applies the same principle repository-wide before Server CLI work. Its parallel batch requires exact disjoint envelopes and the `parallel-tasks` approval gate.
- Current upstream-provider shape adapters and active security, corruption-detection, idempotency, secret-purge, path-authority, and crash-recovery fences are not historical Agent Deck compatibility merely because their code uses fallback-like logic. They remain unless the T1.5 evidence proves their current purpose absent.
- P0's Team/permissions cleanup and protected Agent/MCP collaboration decisions remain unchanged.

## Evidence Already Confirmed

- Current top-level Desktop navigation contains only Live, Pending, History, Issues, and Data. `TeamHub` has no production importer.
- `team-data-source.ts` is consumed only by the unreachable `TeamHub`/`TeamDetail` presentation chain.
- Team-related helpers are not uniformly dead: session cards, Pending, Tasks, Messages, and activity presentation reuse some files below `TeamDetail/`.
- Local cross-session message reads and notifications are active in `SessionDetail/MessagesPanel.tsx`; they must survive removal of Team-page CRUD.
- Team persistence and lifecycle logic remain active for Agent/MCP collaboration and session archive/delete cleanup; P0 must not remove the team repository or trusted runtime collaboration.
- The removed permissions page is explicitly covered by a test that asserts no “权限” tab and no `getRemoteHostSessionPermissions` call. That preload call has no production renderer consumer.
- Permission prompts, Pending permission responses, session creation/runtime permission modes, sandbox/approval controls, permission previews, and adapter permission controllers remain active. They are not part of the removed permissions-page slice.

## Cleanup Proof Standard

A candidate may be removed only when all applicable checks pass:

1. No current reachable product entry, trusted Agent/MCP path, deployment path, or package export consumes it.
2. No current writer emits the legacy shape and no supported persisted artifact requires its reader.
3. No documented upgrade or rollback window requires it.
4. It is not a security fence, corruption repair, idempotent data backfill, provider-version adapter, protocol negotiation path, or external API compatibility boundary.
5. Exact replacement/move steps preserve every still-live consumer.
6. Focused tests plus integrated typecheck/test/build checks pass after removal.

“No `rg` reference” is useful evidence but is not sufficient by itself for dynamically registered IPC, package exports, serialized schemas, Electron preload APIs, provider payloads, or deployment scripts.

## Batch 1 — Parallel Read-Only Audits

Batch 1 intentionally performs no source edits. Its reports make the later destructive write sets exact and disjoint. Both reports are integrated into this file by the lead after results return.

### Envelope P0-A — Removed Team and Permissions Product Surfaces

#### Brief

- Goal: produce an exact delete/trim/move/retain manifest for code related to the removed Team page and removed session-permissions page.
- Inputs:
  - `src/renderer/components/TeamHub.tsx`, `TeamDetail/`, `team-data-source.ts`, and their tests.
  - Current imports of Team-detail helpers from Session list/detail, Pending, Tasks, Messages, and activity views.
  - `src/preload/api/teams.ts`, `src/main/ipc/teams.ts`, and matching IPC constants/types.
  - Remote Team contracts, Core runtime, main service, IPC, preload, and tests.
  - `session.permissions.get`, `SessionPermissionsRead`, its DTO/parser, Core runtime, main service, IPC, preload, and tests.
  - README/current navigation and current Remote renderer reachability.
- Exclusions that must be retained unless concrete contrary evidence is reported:
  - Agent/MCP team creation, membership, messaging, tasks, lifecycle, handoff, and persistence.
  - Session-scoped team metadata/badges, Tasks, cross-session Messages, and activity descriptions.
  - Pending permission requests/responses, plan/diff approval flows, permission mode/sandbox/approval controls, scanners, previews, and provider permission controllers.
- Allowed source writes: none.
- Expected output:
  - Exact file/symbol classification table: `delete`, `trim`, `move`, `retain`, or `uncertain`.
  - For every delete/trim item: all known consumers/producers, why none remain, shared-file edits needed, focused tests to delete/update/add, and rollback consequence.
  - Proposed disjoint cleanup write set for a later P0-A implementation task.
  - Explicit list of misleading names/docs/tests that should be corrected without deleting live behavior.
- Validation standard:
  - Import graph and symbol searches from renderer through preload, IPC, main service, Core runtime, and trusted Agent/MCP paths.
  - Identify dynamic registration and serialized contract boundaries that text-reference counts can miss.
  - No source mutation; report any ambiguity instead of inferring deletion safety.
- Tier: T2 because the audit crosses renderer, IPC, protocol, Core, and trusted collaboration boundaries.

#### Mechanism

- Selected: native Codex collaboration agent via `spawn_agent`.
- Capability inventory: the mechanism supports a fresh bounded context, explicit Codex model/reasoning selection, concurrent execution, and a result returned to the lead. It shares the repository filesystem and does not provide a per-agent path-level write sandbox.
- Fallback: lead performs the audit serially only if native dispatch fails twice under the exact approved envelope. No cross-adapter substitution is pre-approved.

#### Controls

| Control | Requested / resolved | Enforcement |
| --- | --- | --- |
| Adapter | Codex | Enforced by native collaboration mechanism |
| Model | `gpt-5.6-sol` | Explicit at dispatch |
| Reasoning | `xhigh` | Explicit at dispatch |
| Context | Fresh (`fork_turns: "none"`) with self-contained brief | Explicit at dispatch |
| Filesystem | Shared repository; read-only task | Read-only is instruction-enforced, not sandbox-enforced; baseline/diff checked by lead |
| Writes | None | Lead quarantines any unexpected mutation |
| Network | Not required | Brief prohibits external research |
| Return | One structured audit report to lead | Native result collection |
| Wait | Lead continues independent planning, then collects result before P0 integration | Native collaboration lifecycle |

#### Runtime

- Pre-dispatch baseline: refreshed clean `main` at `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222` (ignored planning files excluded).
- Dispatch history: `/root/p0_surface_audit` started prematurely at `2026-08-13T17:48:48Z` and was interrupted at `2026-08-13T17:50:32Z` after the user clarified that scanning must wait for approval of the complete implementation plan. No partial report is accepted.
- Observed controls: native Codex dispatch accepted explicit `gpt-5.6-sol`, `xhigh`, and fresh context; no substitution reported. Read-only behavior was instruction-enforced, and the lead verified the source baseline after interruption.
- Accepted dispatch: `/root/p0_surface_audit_fresh` was started from the isolated worktree with the unchanged approved envelope. Native dispatch accepted explicit `gpt-5.6-sol`, `xhigh`, and `fork_turns: "none"`; no substitution was reported.
- Outcome and validation result: completed read-only. The report traced renderer, preload, IPC, main service, Core runtime, trusted Agent/MCP paths, dynamic registration, and serialized contracts. It returned the exact manifest integrated below. The lead accepted it only after the source worktree remained clean at `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222`.

### Envelope P0-B — Repository Compatibility-Code Audit

#### Brief

- Goal: find compatibility-only code that has no remaining supported purpose and produce an evidence-backed cleanup manifest.
- Inputs: all repository source, scripts, deployment assets, tests, package exports, and current plans/changelogs/reviews relevant to each candidate.
- Candidate discovery includes explicit `legacy`/`compatibility`/migration markers, versioned readers, aliases/facades, old IPC migration ledgers, data repairs/backfills, provider fallbacks, deployment evidence compatibility, and dormant tests.
- Hard exclusions from deletion proposals unless the report proves their support window is closed and the parent plan no longer requires them:
  - Existing `.agentdeck-connection`, Remote profile, bridge/admission, topology, Feishu config, or persisted SQLite compatibility needed for the planned `server-core` → `full` migration.
  - Database migrations/repairs needed to open an existing supported user database.
  - Protocol negotiation for supported Desktop/Server version skew and rollback.
  - Provider payload normalization for supported Claude/Codex/Grok versions.
  - Deployment rollback/evidence compatibility and security validation.
  - Public package/plugin/API compatibility still documented or exported.
- Allowed source writes: none.
- Expected output:
  - Candidate table with exact file/symbol, compatibility purpose, current producer, current consumer, persisted/external boundary, documented support evidence, proposed disposition (`remove`, `retain`, `expiry decision needed`, `covered by planned migration`), and confidence.
  - Separate “safe cleanup now” list containing only candidates that satisfy the Cleanup Proof Standard.
  - Proposed disjoint cleanup batches grouped by files, with validation commands and rollback impact.
  - List of stale comments/tests that describe bugs in old implementations but are not compatibility code.
- Validation standard:
  - Trace both producers and consumers, including dynamic registration, serialized files, release/rollback scripts, and package exports.
  - Consult relevant changelog/review/plan evidence for support windows.
  - No source mutation; uncertain candidates stay retained and become explicit decisions.
- Tier: T2 because an incorrect removal can corrupt persisted state, break rollback, or sever external compatibility.

#### Mechanism

- Selected: a second native Codex collaboration agent via `spawn_agent`, concurrent with P0-A.
- Capability inventory: same as P0-A. The report scope is repository-wide but read-only and independent of P0-A's product-surface-specific audit.
- Fallback: lead performs the audit serially only if native dispatch fails twice under the exact approved envelope. No cross-adapter substitution is pre-approved.

#### Controls

| Control | Requested / resolved | Enforcement |
| --- | --- | --- |
| Adapter | Codex | Enforced by native collaboration mechanism |
| Model | `gpt-5.6-sol` | Explicit at dispatch |
| Reasoning | `xhigh` | Explicit at dispatch |
| Context | Fresh (`fork_turns: "none"`) with self-contained brief | Explicit at dispatch |
| Filesystem | Shared repository; read-only task | Read-only is instruction-enforced, not sandbox-enforced; baseline/diff checked by lead |
| Writes | None | Lead quarantines any unexpected mutation |
| Network | Not required | Brief prohibits external research |
| Return | One structured audit report to lead | Native result collection |
| Wait | Lead continues independent planning, then collects result before P0 integration | Native collaboration lifecycle |

#### Runtime

- Pre-dispatch baseline: refreshed clean `main` at `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222` (ignored planning files excluded).
- Dispatch history: `/root/p0_compat_audit` started prematurely at `2026-08-13T17:48:48Z` and was interrupted at `2026-08-13T17:50:32Z` after the user clarified that scanning must wait for approval of the complete implementation plan. No partial report is accepted.
- Observed controls: native Codex dispatch accepted explicit `gpt-5.6-sol`, `xhigh`, and fresh context; no substitution reported. Read-only behavior was instruction-enforced, and the lead verified the source baseline after interruption.
- Accepted dispatch: `/root/p0_compat_audit_fresh` was started concurrently from the isolated worktree with the unchanged approved envelope. Native dispatch accepted explicit `gpt-5.6-sol`, `xhigh`, and `fork_turns: "none"`; no substitution was reported.
- Outcome and validation result: completed read-only. The report traced current and historical producers/consumers, schema and wire boundaries, package exports, deployment/rollback evidence, provider variants, and security fences. It found exactly one safe compatibility cleanup, integrated below. The lead accepted it only after the source worktree remained clean at `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222`.

## Batch 1 Approval Semantics

- Approval phrase: `批准 P0 Batch 1` (or an unambiguous equivalent) approves exactly Envelopes P0-A and P0-B above.
- Approval record: approved through the Agent Deck plan gate at `2026-08-13T17:48:01Z`, against clean `main` commit `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222` (ignored planning files excluded).
- This early approval locks the envelope but does not itself start work. The complete parent plan and isolated worktree gates are now satisfied; refresh the clean branch baseline immediately before dispatch, then run the two unchanged envelopes concurrently.
- That approval remains valid for later dispatch during this plan only if every Brief, Mechanism, and Control field remains unchanged.
- One exact-envelope transient retry per task is covered.
- Any changed model, reasoning, context mode, write permission, scope, fallback, or validation standard requires reapproval.
- The shared-filesystem limitation is material: task agents are instructed to be read-only, and the lead must compare the worktree to the captured baseline before accepting either report.

## Batch 1 Integrated Runtime Evidence

- Dispatch baseline: clean branch `codex/feishu-one-click-server` at `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222`.
- Pre-dispatch plan SHA-256 values: parent `fd236d0544c77df3d88b496f6395fdd6d7db8a9202aaf29e422b576d3a121921`; child `a272e31bb8cff84b68a54d0e3f6224d17d1d11acd4284d8fb07bf059a88e80b8`.
- Both accepted workers reported no mutation and no network use. At `2026-08-13T18:15:45Z`, the lead re-ran full tracked/untracked status, HEAD, diff, and both plan hashes. HEAD, cleanliness, and hashes matched the dispatch baseline exactly.
- The earlier interrupted `/root/p0_surface_audit` and `/root/p0_compat_audit` outputs remain rejected and were not used.
- Parallel-task controls were satisfied without fallback: native Codex, `gpt-5.6-sol`, `xhigh`, fresh context, read-only instruction fence, structured return, and lead-owned integration.

## Exact Evidence-Gated Cleanup Manifest

The following is the complete authorized P0 source mutation set. Anything not named here is retained. Shared seams and integration remain lead-owned and serial.

### P0-A — Removed Team product surface

| Disposition | Exact files/symbols | Evidence and required preservation |
| --- | --- | --- |
| Delete | `src/renderer/components/TeamHub.tsx`, `TeamHub.test.tsx`, `team-data-source.ts`, `team-data-source.test.tsx` | `TeamHub` has no production importer; its data source is consumed only by the unreachable Team presentation chain. |
| Delete after moving live helpers | Team-only files under `src/renderer/components/TeamDetail/`: `index.tsx`, `Header.tsx`, `LineageSection.tsx`, `MembersSection.tsx`, `MessagesSection.tsx`, `PendingSection.tsx`, `TasksSection.tsx`, `EventsSection.tsx`, `member-candidates.ts`, `events-payload-describe.ts`, and Team-only tests | Move `relativeTime`, `lifecycleLabel`, and `agentIdLabel` plus their live tests to a neutral presentation helper. Delete Team-only `roleLabel` and `eventKindLabel`. Preserve Session list/detail, Pending, Tasks, Messages, and activity consumers. |
| Move, then delete Team API module | From `src/preload/api/teams.ts`, move `listAgentDeckMessagesBySession` and `onAgentDeckMessageChanged` to the session/message facade; delete all Team-page APIs and the source file | Cross-session Session Messages remain live. |
| Move, then delete Team IPC module | From `src/main/ipc/teams.ts`, move `AgentDeckMessageListBySession` to session/message IPC and `SummarizerLastErrors` to misc/diagnostics IPC; delete Team-page handlers and `teams-handoff-routing.test.ts` | Message notification bridge and summarizer diagnostics remain live. |
| Remove local renderer-only channels | `AgentDeckTeamList`, `AgentDeckTeamGet`, `AgentDeckTeamGetFull`, `AgentDeckTeamCreate`, `AgentDeckTeamArchive`, `AgentDeckTeamUnarchive`, `AgentDeckTeamAddMember`, `AgentDeckTeamRemoveMember`, `AgentDeckTeamShutdownAllTeammates`, `AgentDeckTeamSendMessage`, `AgentDeckMessageListByTeam`, `AgentDeckMessageCancel`, `TaskListByTeam`, `IpcEvent.AgentDeckTeamChanged`, and matching `CURRENT_API_CLASSIFICATION` entries | Remove registration/preload/constants together. Retain `AgentDeckMessageListBySession`, `IpcEvent.AgentDeckMessageChanged`, and `SummarizerLastErrors`. |
| Trim bootstrap/event bridge | `src/main/index/bootstrap-wiring.ts`, `_deps.ts`, and focused tests | Remove Team-changed renderer sender/listeners; retain message bridge. Rename `makeDebouncedTeamSender` to neutral `makeDebouncedKeyedSender`. |
| Remove Remote Team product contract | `src/contracts/teams.ts` and test; Team entries in `methods.ts`; `AgentDeckCapability.Teams`; `src/hosts/server-core/team-runtime.ts` and test; its decorator in `runtime-composition.ts` | These methods served only the removed Remote Team page. Trusted Agent/MCP team collaboration does not use this client product RPC chain. |
| Split and trim Remote main controllers | Move usage-only code from `service-teams-usage.ts` to `service-usage.ts` and from `input-validation-teams-usage.ts` to `input-validation-usage.ts`; delete Team controllers/parsers and their Team tests | Preserve Data-page token/provider usage behavior. |
| Remove Remote Team façade | Team methods/DTOs/constants in `src/main/remote-host/service.ts`, `index.ts`, `src/main/ipc/remote-host.ts`, `src/preload/api/remote-host.ts`, `src/shared/ipc-channels.ts`, and `src/shared/remote-host/types.ts` | Delete the five `teams.*` client methods coherently across Core, main, IPC, preload, and DTO boundaries. |
| Remove Team resource-revision lane | `'teams'` in `REMOTE_HOST_RESOURCE_KINDS` / `RemoteHostResourceRevisions`; Team lane logic and fixtures in `resource-invalidation.ts` and affected tests | Retain Team-event invalidation of `session-list` and `session-detail`, because session-scoped team metadata remains live. |
| Delete dead repository aggregates | `agentDeckTeamRepo.getWithMembers` from team CRUD/interface/proxy/mock; `eventRepo.findTeamEvents` and its isolated test block | Computed reads were consumed only by the deleted Team detail stack; no rows/events are deleted. |
| Retain uncertain aggregate | `agentDeckMessageRepo.listByTeam` and `ListMessagesByTeamOptions` | It has no remaining UI caller after cleanup, but persistence/collaboration is protected and no product expiry decision exists. |

### P0-A — Removed session-permissions projection surface

| Disposition | Exact files/symbols | Evidence and required preservation |
| --- | --- | --- |
| Delete contract | `src/contracts/session-permissions.ts` and test; its index export; `session.permissions.get` method metadata; `AgentDeckCapability.SessionPermissionsRead` | Current Session detail has five tabs and no Permissions tab; no production renderer consumes the projection. |
| Trim Core projection | Permission-only branches/imports/projections in `src/hosts/server-core/session-metadata-runtime.ts` and its first three permission tests; protocol-minor branch in `src/hosts/daemon/connection-handshake.ts` | Retain `session.messages.list` and all pending/runtime permission enforcement. |
| Trim main/IPC/preload chain | `permissions()` in `service-session-metadata.ts`; `parseRemoteHostSessionPermissionsRequest`; permission DTOs in `session-request-types.ts`; `getSessionPermissions`; `RemoteHostIpcInvoke.SessionPermissionsGet`; main IPC handler; preload method/imports | Remove the entire unused projection chain at one synchronized seam. |
| Replace obsolete negative mock | Permission API/capability mock in `SessionDetail.source-shell.test.tsx` | Assert the exact supported tab IDs directly: activity, tasks, diff, summary, messages. |

### P0-B — Compatibility cleanup

Historical disposition at P0 completion. Rows marked retained below are superseded for re-evaluation by D-019/T1.5; they are not current preservation requirements.

| Disposition | Exact files/symbols | Proof / boundary |
| --- | --- | --- |
| Remove now | Object-valued `{ type: string }` branch in `readCodexChangeKind` in `src/main/store/file-change-repo.ts` and `src/main/store/file-change-read-repo.ts` | Current Codex translation canonicalizes `metadata.changeKind` to a string before persistence; strict current schema v62 postdates that writer; all other current readers are string-only; no fixture or supported artifact requires the object shape; `REVIEW_208` already records this exact cleanup decision. Rows remain stored, so rollback impact is limited to unsupported object metadata becoming visible rather than no-op-filtered. |
| Retain / planned migration | Remote profile v1/v2 readers; Feishu SQLite v1→v2; retired `sessionCreationCatalog` stripping; `.agentdeck-connection` v2; all `server-core` topology readers needed by T1 | Persisted or external compatibility remains supported or is explicitly required by the approved topology migration. |
| Retain | Protocol 2.0–2.6 negotiation/capability gates; legacy Remote presentation/input fallbacks; optional older DTO fields | Desktop/Core version skew and rollback remain supported. |
| Retain | Pending permission preview fallbacks and approval bounds; file-change path authority; retired Grok credential purge | These are active security/data-boundary fences. |
| Retain | Claude/Codex/Grok provider payload aliases; `node_repl` Browser compatibility | Current bundled/external provider and Browser paths still consume them. |
| Retain | Legacy plus generation-bound deployment evidence; instance-manager rollback/recovery readers | Official deployment emitters and recovery still require both evidence forms. |
| Retain pending expiry evidence | Desktop token-usage repair and Server Core token-usage backfill | Supported/offline databases may still need the idempotent repairs; no fleet-wide completion marker exists. |

### Protected live invariants

- Keep all Agent/MCP team creation, membership, messaging, tasks, lifecycle, handoff, persistence, schemas, migrations, and cleanup.
- Keep session-scoped team metadata/badges, Session Tasks, cross-session Messages, Pending views, and activity descriptions.
- Keep pending permission request/response flows, plan/diff review, permission scanners/previews, provider permission controllers, runtime permission/session/sandbox/approval controls, and creation-time controls.
- Historical P0 rule: keep supported database migrations/repairs, protocol skew, deployment rollback/evidence, provider adapters, public package/plugin boundaries, secret purges, and path-security fences. D-019 now removes historical Agent Deck compatibility while preserving only demonstrably current provider/security/recovery purposes.
- Keep `agentDeckMessageRepo.listByTeam` until an explicit later product expiry decision; do not infer deletion from zero current renderer callers.

## Batch 2 — Evidence-Gated Cleanup (Lead-Owned and Complete)

Batch 2 performs only the exact deletions, moves, and trims above. The complete parent plan approval authorizes this bounded cleanup; no additional routine confirmation is required. Per the continuation instruction, implementation is lead-owned and serial.

The lead will:

1. Merge both audit reports and resolve overlaps.
2. Publish an exact deletion/trim/move manifest with live-behavior invariants.
3. Keep shared contracts, IPC registries, package exports, and integration glue in the lead write set.
4. Apply all cleanup serially with `apply_patch`; no additional implementation agent is authorized for this batch.
5. Attach focused validation to each task and one integrated typecheck/test/build check.
6. Record focused and integrated validation results below before advancing T0.

Implementation result: complete. The lead applied only the published manifest:

- Removed the unreachable Local and Remote Team product CRUD projection, Team renderer chain,
  obsolete Team resource revision, and the unused `session.permissions.get` product projection.
- Moved the live session message IPC/preload/event bridge and summarizer diagnostics to neutral
  session/diagnostics owners, and moved live session presentation helpers to
  `session-presentation.ts`.
- Retained Agent/MCP team persistence, membership, messaging, tasks, lifecycle, handoff, session
  metadata, Pending approval, runtime permission/sandbox controls, and `listByTeam` exactly as the
  evidence manifest required.
- Removed only the object-valued `{ type }` fallback in the two `readCodexChangeKind` readers; all
  persisted, protocol, provider, rollback, security, and topology compatibility readers remain.

Validation and acceptance evidence:

- Cohesive T0 source/record commit: `ab37159e` (`refactor: remove dormant owner product surfaces`).
- `git diff --check` passed, and an exact product-symbol search found no remaining Team page/CRUD,
  `session.permissions.get`, Team capability, Remote Team DTO, or Remote permission projection
  surface. Remaining `AgentDeckTeam*` references are the protected internal collaboration model.
- Focused Electron validation passed 15 files / 75 tests; additional diagnostics, resource,
  renderer, and presentation coverage passed 5 files / 41 tests; Electron-native SQLite/runtime
  composition coverage passed 2 files / 14 tests.
- `pnpm typecheck` and `pnpm check:architecture` passed.
- The full suite passed: 952 files passed, 2 skipped; 6,049 tests passed, 3 skipped.
- `pnpm build` passed and produced main, preload, and renderer bundles.
- The required main/preload development restart was exercised through an isolated temporary
  `userData`: main/preload rebuilt, a fresh schema v62 initialized, MCP and Hook services listened
  on the isolated port 47831, and the renderer window recovered to healthy before clean shutdown.
  The temporary probe was reverted with no source diff and its temporary directory moved to Trash.
- Every changed production TypeScript/JavaScript file is below 500 lines; no file-size exception is
  required.

## P0 Exit Criteria

- Removed Team and permissions pages have no remaining page-only renderer, preload, IPC, Remote service, Core method, capability, or test surface.
- Current session-scoped team metadata, tasks/messages, Agent collaboration, and permission approval/runtime controls remain covered.
- Every removed compatibility path has an evidence record proving no supported producer/consumer/persisted/rollback boundary remains.
- Remote Owner Product v1 is derived after cleanup and excludes dormant/internal methods by construction.
- Focused tests, typecheck, applicable static checks, and build pass; README/changelog/review records describe the cleanup and support-window decisions.
