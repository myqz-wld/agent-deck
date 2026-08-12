---
plan_id: PLAN_35
title: Remote transport and UI convergence
status: closed-at-user-request
created_at: 2026-08-11
updated_at: 2026-08-11
completed_at: 2026-08-11
base_commit: 012306082ea33db399d642cadf3ba922391183ce
package_commit: 8b67c4a9324938cfd78bc35a1705951b3f2bddf5
related_changelog: CHANGELOG_591
related_review: REVIEW_232
---

# Remote Transport and UI Convergence Plan

## Archive status

Implementation tasks T0–T8, source review, commits, push, and the clean-commit macOS package completed. The user explicitly requested closure before installing that package, so installed-runtime acceptance, real Claude/Codex Remote checks, and T10 Feishu preparation are intentionally not claimed. The remaining work is closed at user request rather than blocked or silently completed.

## Identity

- Plan id: `remote-transport-ui-convergence`
- Status: closed at user request after packaged delivery
- Created: 2026-08-11
- Base commit: `012306082ea33db399d642cadf3ba922391183ce`
- Source repository: `/Users/wanglidong/Repository/agent-deck`
- Implementation isolation: Agent Deck worktree
  `agent-deck-019fec55-85a-msow8y9m`, created at the frozen base and closed after delivery.
- Final integration: product commit `8b67c4a9324938cfd78bc35a1705951b3f2bddf5` was pushed to
  `origin/main`; the subsequent plan-archive commit is documentation-only.

## Goal

Make the Remote/Relay experience a reliable, source-authoritative counterpart of Local across
connection lifecycle, navigation, page availability, session list presentation, detail/composer,
Team, Issues, Data/usage, Settings, Assets, and session creation. Fix the live connection failure
before shipping UI changes, then validate and deploy the same pushed release end to end.

## Invariants

1. Never signal, kill, Inspector-inject, restart, overwrite, or reinstall the running desktop or
   Worker directly. Any server/Worker lifecycle mutation must use the repository's official
   deployment wrappers after a clean pushed release. The user performs desktop installation.
2. Remote pages never read Local session, team, issue, usage, provider-home, Hook, or asset data as a
   fallback. Missing connection/capability is an explicit fail-closed state.
3. Stale capabilities may describe the last negotiated Core but may never authorize a request when
   `source.usable` is false.
4. Do not solve the duplicate-terminal-response failure by blindly ignoring all duplicate frames.
   Preserve fatal handling for unknown, conflicting, queued, or identity-mismatched responses.
5. UI parity means shared structure, spacing, hierarchy, state presentation, empty/loading/error
   treatment, and supported interactions. It does not mean exposing a Local-only action against a
   Remote source. Unsupported actions must be omitted or explicitly disabled, never silently routed
   to Local.
6. Keep adapter-native semantics exact: Claude `permissionMode`/`claudeCodeSandbox`, Codex
   `approvalPolicy`/`codexSandbox`, Grok `sessionMode`/`grokSandbox`. Cross-adapter fields remain
   rejected.
7. Local and Remote detail use the same tab catalog. Do not reintroduce Remote-only `Pending` or
   `Runtime` tabs; runtime controls remain above the composer and the global Pending page remains.
8. Every request/result that can outlive a render is fenced by profile + authoritative Core + Worker
   generation identity and sequence/revision semantics.
9. Fix confirmed source defects, validate, commit, and push before any deployment.
10. Temporary live probes, credentials, logs, and raw evidence never enter Git.

## User-owned Decisions and Decision Ledger

| ID | Decision / impact | Owner | Status | Answer / constraint |
|---|---|---|---|---|
| D-001 | Scope of parity | User | Confirmed | Align the whole Remote page experience, not only the new-session form. |
| D-002 | Connection manager layout | User | Confirmed | Remove the unused permanent right pane; use a compact single-column manager and reveal add/edit only on demand. |
| D-003 | Data authority | User + project | Confirmed | Remote Settings, Hooks, Assets, Team, Issues, Usage and sessions must be Worker/Core-owned; no Local fallback. |
| D-004 | Detail tabs | User | Confirmed | Remove extra Pending/Runtime detail tabs from both source modes. |
| D-005 | Process safety | User | Constrained | Do not casually kill/restart desktop or Worker. Use controlled official paths only when necessary. |
| D-006 | Session-list parity behavior | User | Delegated | Reuse shared UI/presentation. Preserve supported Remote actions and make unsupported actions explicit; do not invent false parity. |
| D-007 | Duplicate-response correction | Engineering | Delegated | Trace first. If evidence proves identical at-least-once delivery, deduplicate only by exact terminal fingerprint and request identity; conflicting duplicates stay fatal. Otherwise fix the emitting/bridging layer. |
| D-008 | Protocol expansion | Engineering | Delegated | Add bounded, minor-gated summary fields only when required for real parity and when the old-client compatibility matrix is testable. Prefer shared presentation over protocol growth. |
| D-009 | Execution and handoff | User | Confirmed | Create this detailed plan, hand off to a fresh session, and continue autonomously through its gates while the user is away. |
| D-010 | Deployment/install | User + project | Confirmed | Commit/push first, deploy with official scripts, build the macOS package, let the user install, then run non-invasive live acceptance. |

### Checkpoints

- Checkpoint A (route selection): passed. All route-changing product choices are confirmed or
  delegated within explicit bounds.
- Checkpoint B (new evidence): implementation must stop for user input only if evidence requires a
  new product/security/data-retention choice outside the ledger. Ordinary engineering tradeoffs are
  delegated.
- Checkpoint C (final review): passed for planning. No unresolved material user-owned decision
  remains.

## Current Evidence

### Repository and deployed state

- `HEAD`, local `main`, and `origin/main` were all `012306082ea33db399d642cadf3ba922391183ce`
  when this plan was created.
- The installed application reports that exact commit. Read-only inspection observed desktop PID
  86857, Worker PID 86523, and optional Provider Supervisor PID 86521. These identifiers are
  evidence only; never target them with signals.
- The prior release fixed fresh cursor baselining and retired replay-gap bindings. The former
  `replay_gap` no longer reproduces.

### Live connection failure

- On the next explicit connect, HostHello succeeds and provides authoritative Core id
  `aws-relay-on-mac:86523:b787e65f-...`, Worker generation 1.
- The first business request then transitions the profile to `incompatible` with
  `protocol_violation`: `Host sent duplicate response for ...:request:2`.
- In `src/clients/ssh/client.ts`, a second response after a request is remembered as `settled` is
  fatal. The current ledger remembers only the state, not the terminal envelope fingerprint.
- `DaemonRequestScheduler` already has a `terminalSent` fence, so the duplicate could originate in
  connection/reconnect/Relay/Worker forwarding or another emission path. Root cause is not yet
  proven.
- A temporary manual live probe failed during SSH key exchange, likely after AWS sshd throttled
  repeated attempts. It was removed before isolation and must not be recreated as a normal suite
  test. If live SSH is retried, use only the known `ubuntu` account and read-only commands after a
  cooling interval.

### Renderer failure and stutter

- After the connection retires, the renderer mounted Team using stale `teams` capability even
  though `source.usable` was false.
- `src/renderer/components/team-data-source.ts` calls `requireProfile()` synchronously inside
  promise-returning methods. `TeamHub` calls `source.list().then(...).catch(...)`; the synchronous
  throw escapes the promise chain and reaches the full renderer error boundary:
  `远程团队数据源尚未连接。`
- `AppWorkspace` currently gates Team/Issues/Data by capability only and not by usable source.
- `useRemoteUsageSource` already includes `source.usable` in its polling gate, but `DataPanel` and
  page mounting still need a consistent availability boundary and explicit offline presentation.
- Repeated effects/error remounting can amplify perceived stutter. Request counts and render/effect
  loops must be measured in tests rather than guessed.

### Connection manager UI

- `RemoteHostManagerDialog` is a fixed split layout: a 56-width sidebar plus a permanent empty
  detail pane. The detail pane only displays instructions/error text when the modal is not editing.
- Add/edit already uses a separate overlay form, so the permanent right pane has no functional
  purpose.

### Session-list parity gap

- Local rows use `SessionCard`: status, title, source badge, provider label, metadata/context chips,
  team roles, live activity, summary/cwd, and supported context-menu actions.
- Remote rows use a separate sparse `RemoteSessionSummaryCard`: status, title, a Remote badge,
  provider label, lifecycle/activity, and timestamp. It does not share the Local card skeleton.
- Remote summary DTO currently includes only id, adapterId, title, status, createdAt and updatedAt.
  First reuse a shared presentational skeleton. Extend the bounded protocol only for fields that are
  authoritative and necessary to avoid misleading placeholders.

## Blindspot Pass

1. A byte-identical duplicate response can be benign at-least-once transport delivery, but an
   unequal duplicate is a protocol integrity failure. Tests must distinguish them.
2. Reconnect can retain logical pending requests while creating a new Core connection; request
   admission, response ledger generation, and replay/idempotency identities must be evaluated
   together.
3. Connection profile selection is not source-mode selection. Fixing the transport must not
   silently switch the current page/source from Local to Remote.
4. Stale capability sets intentionally survive some transient states for diagnostics. Every UI
   consumer must combine capability with current usability; clearing capabilities globally may
   destroy useful state and is not the preferred fix.
5. React effects can throw before `.catch()` when a supposedly promise-returning source method
   throws synchronously. Data-source interfaces must honor asynchronous rejection, and consumers
   should still guard provider calls.
6. Remote session pagination means loaded rows may be fewer than total. Counts must distinguish
   total vs loaded without adding a Remote-only decorative header that breaks Local parity.
7. Extending session summaries affects contracts, strict parsers, protocol compatibility,
   Server Core, main, preload/shared DTOs, and fixtures. Any additive field needs a protocol-minor
   compatibility decision; strict old parsers cannot receive unadvertised fields.
8. Remote Settings contains a legitimate Local-only partition for desktop appearance/notifications.
   It must remain visibly labeled as local desktop state while provider defaults and Hooks remain
   Worker-owned.
9. Remote Assets is intentionally read-only and cannot reveal a Worker path in Finder. Local assets
   may also be read-only depending on asset source. The UI must explain authority/source, not imply
   that all Local assets are editable.
10. Full renderer error boundaries can hide the original request failure and create remount churn;
    all page-level promise paths need rejection tests with no uncaught error.
11. AWS administrative SSH can be temporarily rate-limited. Live evidence should supplement, not
    replace, deterministic fixture tests.
12. The repository has a 500-line production-file guardrail. Shared parity work should extract
    focused availability/presentation helpers rather than growing AppWorkspace or SessionList.

## Route Options

### Route A — shared presentation + centralized source availability (selected)

- Establish one Remote availability decision for pages.
- Make all data-source methods honor their promise contract and catch synchronous provider faults.
- Extract a shared session-card skeleton and source-neutral section/count presentation.
- Expand the wire contract only for bounded authoritative fields that materially improve parity.
- Trace and correct the transport at the narrowest layer supported by frame evidence.

Benefits: fixes the architecture instead of individual screenshots; maximizes Local/Remote UI reuse;
preserves source authority. Cost: touches renderer, contracts and possibly transport. Risk is bounded
by staged tests and compatibility gates.

### Route B — patch each Remote component independently (rejected)

Fast initially, but perpetuates duplicate markup, inconsistent offline behavior and repeated
regressions. This conflicts with the user's request to stop rework.

### Route C — copy the complete Local DTO into Remote (rejected as default)

Would produce visual data quickly but expands disclosure, parser and compatibility surfaces and may
export desktop-only state. Selective protocol growth under Route A is safer.

## Selected Design

### 1. Transport terminal-response authority

- Add deterministic frame-level tests spanning SSH client, Relay client bridge, Worker bridge and
  daemon scheduler for first request, reconnect, queued requests, cancellation, deadline and
  response-loss sequences.
- Record terminal envelopes in a bounded ledger using a canonical deterministic fingerprint only if
  live/fixture evidence proves identical at-least-once delivery is possible.
- Exact same request id + exact same terminal fingerprint may be ignored after settlement; same id
  + different terminal type/result/error/revision remains `protocol_violation`.
- If a bridge emits twice, fix the bridge instead and retain strict client behavior.
- Never retry non-idempotent mutations merely because a terminal frame was lost; existing mutation
  ledgers remain authoritative.

### 2. Remote availability SSOT

- Extract a small helper/component that classifies Remote page state: connected and capable,
  connecting/reconnecting, offline/incompatible, or connected but unsupported.
- AppWorkspace must not mount Team, Issues, Data or detail consumers unless connected/usable and
  capable. Live/Pending/History may mount their own source-aware shell only if they explicitly handle
  unusable state without issuing requests.
- Use consistent, source-specific empty/error copy. Never say a page is Local-only when the Remote
  capability exists but the connection is offline.
- Data sources return rejected promises rather than throwing synchronously. Consumers wrap calls in
  an async `try/catch` boundary so hostile/legacy providers cannot reach the renderer error boundary.

### 3. Compact connection manager

- Replace the split layout with a centered single-column modal sized to its content and bounded by
  viewport height.
- Header: title, concise source-selection note, close button, Add action.
- Body: scrollable connection cards. Each card contains label, endpoint, status dot/label, bounded
  error/recovery message and inline Connect/Disconnect, Edit and Delete actions.
- Clicking a card may still select/focus the profile, but there is no permanent blank detail pane.
- Add/edit opens the existing credential form over the compact manager. Preserve confirmation,
  busy state, fail-closed recovery copy and credential secrecy.

### 4. Session-list presentation parity

- Extract shared card frame/header/status/metadata/secondary-line primitives used by both Local and
  Remote.
- Use the same card padding, borders, selected/hover state, typography, section gaps, status badge
  and adapter label for equivalent states.
- Use the same Active/Dormant section structure. Closed records remain History-owned unless the
  established Local live selector includes them; do not add a Remote-only Closed section to Live.
- Preserve the total session count in the common surrounding/header stats. If pagination requires a
  loaded-count hint, present it next to Load More rather than as a Remote-only top banner.
- Render only authoritative metadata. For unavailable Remote branch/live summary/pin/archive/delete,
  omit the action or show an explicit capability state; never query Local stores.
- Add a DOM/class parity regression that renders equivalent Local and Remote records and compares
  the shared skeleton and labels while allowing source-authority-specific content.

### 5. Remaining page and authority audit

- Live, History, Pending, Detail/composer, Team, Issues, Data, Settings, Assets, header totals/rates,
  new-session and dialogs each get an explicit matrix test for Local, Remote connected, Remote
  connecting/offline, and Remote connected without capability.
- Verify Settings provider defaults/Hook mutations call only `node.configuration`/`node.hook.*` in
  Remote. Keep desktop appearance in a clearly labeled Local desktop partition.
- Verify Assets list/content call only `node.assets.*` in Remote; no Finder/local editor fallback.
- Verify Team/Issues/Usage do not poll or retry while unusable and clear stale data on source identity
  change.

### 6. Performance/stutter containment

- Count requests in fake-timer tests across offline transitions, identity changes and page switches.
- Assert zero Remote page requests while unusable and at most one initial load per stable identity
  plus documented polling intervals.
- Preserve sequence/identity cancellation so stale responses cannot remount or repopulate pages.
- Profile only with read-only logs/test counters; do not attach Inspector to the installed desktop.

## Deterministic / Model Boundary

No product LLM call is required for implementation. Semantic work is limited to engineering review
of root cause and UI composition. Exact operations remain deterministic:

- Protocol envelope fingerprinting: canonical serialization + hash in code, test vectors pinned.
- Capability/availability classification: pure function with exhaustive table tests.
- DTO parsing and bounds: strict schemas and exact-key/version tests.
- Session presentation mapping: pure functions with fixture snapshots/DOM assertions.
- Record/index updates: explicit file edits plus repository validation scripts.

If reviewers are later requested, they receive only the final diff, plan, validation evidence and
named risk surfaces; repository assembly and finding tracking remain deterministic.

## Executable Tasks

### T0 — Activate isolation and establish state

- Owner: successor implementation session
- Dependencies: none
- Write areas: plan execution-state section only
- Steps:
  1. Confirm worktree cwd and frozen base commit.
  2. Confirm main source checkout was clean when isolated.
  3. Record worktree path below and create a durable branch before the first commit.
  4. Read `CLAUDE.md`, `resources/codex-config/CODEX_AGENTS.md`, this plan, and
     `UI_COPY_LANGUAGE.md`.
- Done: isolated clean worktree at the exact base; plan updated with next action.

### T1 — Prove the duplicate-response mechanism

- Dependencies: T0
- Primary read/write areas:
  - `src/clients/ssh/{client.ts,response-ledger.ts,*.test.ts}`
  - `src/hosts/relay/**`
  - `src/hosts/local-worker/**frame**`
  - `src/hosts/daemon/{connection.ts,request-scheduler.ts}`
- Steps:
  1. Add a reusable deterministic frame trace fixture, not a live credential test.
  2. Reproduce the first business request and reconnect/retained-pending sequences.
  3. Prove whether duplicate bytes originate before daemon emission, within Relay/Worker forwarding,
     or only after reconnect/replay.
  4. Use read-only production logs/SSH only if needed and available; no lifecycle mutation.
- Done: a failing regression identifies the responsible layer, or exact identical terminal
  at-least-once delivery is proven with fingerprints. No speculative production fix.

### T2 — Correct transport and recovery semantics

- Dependencies: T1
- Steps:
  1. Implement the narrow fix selected by evidence.
  2. Keep unknown/conflicting duplicates fatal.
  3. Cover result/error, revision drift, reconnect generation, cancel/deadline, queued requests,
     response loss and mutation idempotency.
  4. Ensure explicit reconnect can recover from the retired incompatible binding without an app
     restart.
- Done: focused transport tests pass; a read-only probe can execute several sequential
  `system.health`/list requests without profile retirement.

### T3 — Centralize Remote page availability and error containment

- Dependencies: T0; may proceed while T1 is investigative, but integrate after T2
- Write areas:
  - `src/renderer/AppWorkspace.tsx`
  - new small availability helper/component
  - Team/Issues/Data source consumers and tests
- Steps:
  1. Add exhaustive availability classification.
  2. Gate consumers by `usable && capability`.
  3. Make Team data-source methods asynchronously reject and make TeamHub catch synchronous faults.
  4. Audit Issues/Data effects and request counts.
  5. Add error-boundary regression tests proving disconnected pages render a stable placeholder.
- Done: no uncaught renderer error for any page during disconnect/reconnect; zero business requests
  while unusable.

### T4 — Replace connection manager split pane

- Dependencies: T0
- Write areas: `src/renderer/components/RemoteHost/**`, `RemoteDialogs.test.tsx`
- Steps:
  1. Convert to compact single-column modal/cards.
  2. Move selected-profile operations and bounded error copy into each selected/active card or a
     compact card action row.
  3. Preserve add/edit overlay and confirmations.
  4. Test empty, one/many profiles, long labels/endpoints/errors, busy and recovery states.
- Done: no permanent right pane or blank instructional region; modal remains usable at small height.

### T5 — Align Local/Remote session-list UI

- Dependencies: T0; protocol additions depend on T2 compatibility checks
- Write areas: SessionList, SessionCard, RemoteSessionSummaryCard/presentation, related contracts and
  Server Core only if needed.
- Steps:
  1. Extract shared card/section primitives.
  2. Remove Remote-only live Closed section and decorative profile/load header.
  3. Preserve total count through existing header/source stats and bounded pagination affordance.
  4. Map authoritative Remote status/adapter/timestamp into the shared skeleton.
  5. Add only necessary bounded summary fields under minor gating, with old/new compatibility tests.
  6. Test equivalent visual hierarchy, selection, loading/error/empty, pagination and counts.
- Done: side-by-side Local/Remote fixture has the same structural UI for equivalent information;
  no Local store read occurs in Remote mode.

### T6 — Complete page/data-authority matrix

- Dependencies: T3, T5
- Areas: Live, History, Pending, Detail/composer, Team, Issues, Data, Settings, Assets, header,
  new-session.
- Steps:
  1. Verify every API call and absence of fallback.
  2. Verify identity/reset/sequence fencing.
  3. Verify detail tab parity and composer controls/images by adapter capabilities.
  4. Verify session total, token/s, daily/provider usage and empty/offline states.
  5. Verify Remote Hook/assets labels explain Worker authority and read-only limitations accurately.
- Done: matrix below is fully checked and test-backed.

### T7 — Performance and race validation

- Dependencies: T2, T3, T5, T6
- Steps:
  1. Fake-timer request-count tests for polling and reconnect.
  2. Rapid source/profile/generation switch tests.
  3. Long-list/dialog overflow tests.
  4. Verify no stale response repopulates a replacement identity.
- Done: no request storm, uncaught rejection, full-boundary remount loop or stale-source UI write.

### T8 — Repository validation and records

- Dependencies: T1–T7
- Steps:
  1. Focused tests for every changed risk surface.
  2. `pnpm typecheck`.
  3. `pnpm test` with the official Electron/better-sqlite3 path.
  4. `pnpm build`.
  5. `pnpm check:deployment`, `pnpm check:linux-headless`, Relay static check, and macOS Worker
     sandbox verification when relevant.
  6. `git diff --check`, production TS/TSX 500-line audit, file-level review expiry.
  7. Create the next numbered changelog/review records and update all required indexes.
- Done: all required checks green; skipped tests have explicit existing reasons; worktree clean except
  intentional final records.

### T9 — Commit, push, deploy and live acceptance

- Dependencies: T8
- Steps:
  1. Commit coherent changes on the durable worktree branch.
  2. Push and fast-forward `origin/main`; verify ahead/behind 0/0 and clean release.
  3. Run official Relay Server `--check`, `--dry-run`, `--upgrade`, `--verify` only if the server
     artifact changed.
  4. Run official Relay Worker check/dry-run/upgrade/verify only after Relay and only if needed.
  5. Build macOS with `pnpm dist:mac`; do not install/overwrite the running app.
  6. Ask the user to install the exact pushed package.
  7. After user confirmation, non-invasively connect and test sequential health/list requests,
     Team/Issues/Data/session total/token rates, Local/Remote list parity, and real Claude/Codex
     sessions. Use Claude DeepSeek `deepseek-v4-flash[1m]` max and Codex `gpt-5.6-sol` low unless the
     user changes the target.
- Done: same commit is installed/deployed; Remote remains connected; no duplicate response/error
  boundary; real sessions complete with expected markers.

### T10 — Resume Feishu preparation

- Dependencies: T9
- Steps: return to the already identified official Feishu long-connection/event permissions/test
  tenant prerequisites; do not mix Feishu credentials or external mutations into the Remote fix.
- Done: user receives the exact preparation checklist or authorizes a bounded live Feishu test.

## Acceptance Checklist

### A. Connection and transport

- [ ] Fresh explicit connect reaches `connected`, not `replay_gap` or `protocol_violation`.
- [ ] Ten sequential read requests receive exactly one accepted terminal result each.
- [ ] Exact benign duplicate behavior, if supported, is fingerprint-verified; conflicting duplicate
      remains fatal.
- [ ] Reconnect with retained reads respects negotiated concurrency and does not mismatch request ids.
- [ ] Cancel/deadline late replies are ignored only under their existing bounded ledger states.
- [ ] Unknown/queued/spoofed responses remain fatal.
- [ ] Profile can recover through explicit Connect without desktop restart after a recoverable fault.

### B. Connection manager

- [x] Modal is compact single-column; no unused right pane.
- [x] Empty, one-profile and many-profile states fit without excessive blank space.
- [x] Each card shows label, endpoint, state and relevant bounded error.
- [x] Connect/Disconnect, Edit, Delete and Add work with busy/confirmation states.
- [x] Add/edit still imports one issued credential without exposing secrets.
- [x] Long labels, endpoints and errors truncate/wrap without horizontal overflow.
- [x] Modal copy still clarifies that managing a connection does not auto-switch the current page.

### C. Offline/error behavior

- [x] Live, Pending, History, Team, Issues, Data and Detail never throw to the app error boundary.
- [x] Team/Issues/Usage make zero business calls while Remote is unusable.
- [x] Connecting, offline/incompatible and unsupported states have distinct accurate copy.
- [x] Stale capabilities never authorize a page request.
- [x] Switching profile/Core/generation clears stale data and rejects late results.
- [x] No Remote error state reads or displays Local data.

### D. Session list parity

- [x] Equivalent Local/Remote cards share border, padding, selected/hover state, title/status hierarchy,
      adapter label and section spacing.
- [x] Live shows the same lifecycle group policy; no Remote-only Closed group.
- [x] Empty/loading/error states use the same visual grammar.
- [x] Total vs loaded pagination is accurate and not presented as a decorative Remote-only banner.
- [x] Load More is bounded and stable.
- [x] Unsupported Remote metadata/actions are not faked or routed to Local.
- [x] Remote list rendering does not subscribe to Local session/event/summary/git stores.

### E. Page and data-source authority

- [x] Team uses only Remote teams methods; detail/mutations remain revision/idempotency fenced.
- [x] Issues uses only Remote issues methods; filters/detail/mutations remain identity fenced.
- [x] Data uses only Remote usage methods; token/s, today, daily, provider quota and truncation render.
- [x] Header total/rates come from Remote when Remote is selected and clear when unusable.
- [x] Settings provider defaults and Hooks target Worker; desktop appearance remains clearly Local.
- [x] Assets target Worker packaged/Provider Home catalog; no Finder/local editor fallback.
- [x] New-session provider/model/thinking and adapter-native controls stay capability-derived.
- [x] Detail/composer share Local shell; no Pending/Runtime tabs; supported mid-turn images remain
      adapter/session negotiated.

### F. Performance and races

- [x] Stable identity causes at most one initial Team/Issues/Data load plus documented polling.
- [x] Offline transition cancels/invalidates polling immediately.
- [x] Rapid source/profile/generation changes cannot repopulate stale UI.
- [x] No unhandled promise rejection or repeated error-boundary remount.
- [x] Connection dialog and 512-row bounded lists remain responsive in component tests.

### G. Release and live validation

- [x] Focused tests, typecheck, full tests, build and relevant deployment/sandbox checks pass.
- [x] Review/changelog records and indexes are valid.
- [x] Git worktree is clean, commit is pushed, local/remote refs align.
- [x] Official Relay/Worker verification is healthy on the pushed commit when deployment is required.
- [ ] User installs the matching macOS package; installed metadata matches the commit.
- [ ] Real Claude DeepSeek max and Codex gpt-5.6-sol low Remote sessions complete.
- [ ] Team, Issues, Data, session total, token/s, Settings/Hook and Assets smoke checks pass without
      Local fallback or process manipulation.

## Validation Matrix

| Surface | Local | Remote connected + capability | Remote connecting/offline | Remote connected without capability |
|---|---|---|---|---|
| Live/list/total | Local stores | Remote summaries + total | stable connection placeholder | base session capability error |
| Pending | Local pending | `pending.*` | no request, connection placeholder | explicit unsupported |
| History | Local history | bounded Remote summaries | no request | explicit unsupported |
| Detail/composer | Local IPC | Remote session APIs | selection retired / placeholder | per-feature disabled |
| Team | Local Team backend | `teams.*` | zero calls | explicit unsupported |
| Issues | Local issue backend | `issues.*` | zero calls | explicit unsupported |
| Data/token/s | Local usage | `usage.*` | zero poll, cleared values | explicit unsupported |
| Settings provider/Hook | Local config/hooks | `node.configuration`/`node.hook.*` | explicit unavailable | upgrade message |
| Assets | Local catalog | `node.assets.*` read-only | explicit unavailable | upgrade message |

## Execution State

- Final status: closed at user request after packaged delivery. Installed-runtime and Feishu
  acceptance were deliberately not run and remain unclaimed.
- Delivery state: implementation commit `a2cfc66009c6656f1c2b603a73389be844dc49e8` was pushed to
  both `origin/codex/remote-transport-ui-convergence` and `origin/main`; both comparisons are 0/0.
  Post-push entrypoint tracing confirms Relay and Worker do not import the changed SSH client, so
  their artifacts do not require deployment. The optional, not-yet-deployed Feishu gateway does
  share the client and will inherit the correction during T10.
- Final packaged source commit is `8b67c4a9324938cfd78bc35a1705951b3f2bddf5`, including the
  artifact-boundary clarification. `HEAD`, `origin/main`, and
  `origin/codex/remote-transport-ui-convergence` are 0/0 aligned and the worktree is clean. The
  official `pnpm dist:mac` chain passed bundled Grok verification, macOS Worker sandbox checks,
  Linux headless build, Electron packaging, and packaged Worker sandbox acceptance. It produced
  `build/dist/Agent Deck-0.1.0-arm64.dmg` (583 MiB), SHA-256
  `128c2614c95b870db94a14657f337744fb4959b4a83c043973e73dab658ad480`. Both build metadata copies
  report clean commit `8b67c4a93249`. The package is locally unsigned because this machine has no
  Developer ID identity; no installation was attempted.
- Latest T8 result: the official Electron suite completed successfully with 905 test files passed,
  2 skipped, 5,848 tests passed and 3 skipped. The skips are the repository's existing conditional
  skips; no new failure or unhandled rejection was observed. The production Electron/Vite build
  also passed and wrote the expected ignored build metadata. Deployment automation and Relay static
  checks passed. The official Linux headless build/check/deployment chain passed after producing its
  required manifest, and the macOS Worker sandbox build/check passed with the provider-native and
  bookmark boundaries intact.
- T8 is complete. Final typecheck and architecture boundaries passed; `git diff --check` passed;
  file-level review expiry was run; all 23 changed production TS/TSX files remain below 500 lines
  (maximum 499). The full 42-path implementation review closed 1 HIGH, 2 MEDIUM and 3 LOW findings
  with no open material finding. `CHANGELOG_591_remote-transport-ui-convergence.md` and
  `REVIEW_232_remote-transport-ui-convergence.md` are uniquely numbered, indexed, and validated.
- Last completed step: T7. Counted fake-timer regressions prove one initial Team/Issues/Data load,
  one Usage read per documented 2.5-second interval, and immediate polling retirement on disconnect.
  The Issues audit first reproduced and then removed a second identical initial request caused by
  the empty-keyword debounce. Same-identity disconnect/reconnect now starts a fresh list without
  waiting for an old in-flight request, and rapid Worker generations 1→2→3 retain only generation
  3 results. The existing long-copy 18-connection fixture and a new interactive 512-session fixture
  cover bounded rendering. The T7 gate passed 8 files / 76 tests, full typecheck/architecture
  boundaries and `git diff --check`.
- Earlier completed step: T6. All six Remote pages now pass through one connected-and-capability
  availability boundary before their consumers mount; reconnecting, offline, incompatible and
  connected-but-unsupported states have stable source-specific copy and make no Local fallback.
  The session source clears lists, totals, pending/detail/runtime/context state while unusable and
  rejects stale actions before IPC. Usage loaders, Settings configuration/Hook results, Assets
  list/viewer results, new-session capability results and the Workspace directory browser are
  fenced across same-identity disconnects. Remote header token rates no longer poll or subscribe
  to Local usage state. Team mutation retries retain one identity-bound intent and expected
  revision; Issues, Data, Settings, Assets, new-session and detail/composer authority paths remain
  Worker-owned. The complete T6 matrix passed 21 files / 138 tests, followed by the added Team
  mutation case (4/4), plus full typecheck, architecture boundaries and diff hygiene.
- Earlier completed step: T5 complete without protocol expansion. Local and Remote Live lists now use
  shared card-frame/header, lifecycle-section, and list-state primitives. Remote no longer renders a
  Live-only Closed group or a decorative profile/load-count banner; total remains in the common app
  header, and bounded pagination remains an explicit Load More action. Remote renders only its DTO
  fields/actions and does not mount Local card/store/git consumers. A four-test parity suite first
  failed on all old divergences, then passed after the shared-presentation refactor; the wider
  session/card/source set passed 35 tests plus full typecheck and diff hygiene.
- Earlier completed step: T4. The permanent split-pane/right-side instructional region was
  removed. `RemoteHostManagerDialog` is now a compact, bounded single-column dialog whose cards
  carry endpoint, status, relevant errors, selection, connection, edit, and confirmed-delete
  controls in context. Add/edit remains an on-demand credential overlay, and recoverable
  Worker-offline state preserves the disconnect path.
- Transport/page foundation remains complete. A deterministic client-stdin trace in
  `src/clients/ssh/client-admission.test.ts` proves that a request synchronously admitted by a
  `connected` state observer is written twice before Relay, Worker, or Core receives it. The first
  write occurs because `handshakeComplete` is already true when `connected` is published; the
  subsequent `onReady` callback clears `sentRequestIds` and redispatches the same pending request on
  the same SSH connection. Production now performs internal `onReady` reconciliation before the
  externally observable `connected` publication. First-connect and reconnect observer regressions
  each observe exactly one request frame; strict unknown/queued/duplicate handling is unchanged.
- Validation performed in this implementation session: required instruction/plan reads, clean base
  and durable branch verification, bounded installed-app and Relay log inspection, complete static
  trace across SSH/Relay/Worker/daemon layers, isolated lockfile install, the red T1 regression
  (`1 failed / 5 passed`, expected one request frame and observed two), then 51 SSH tests, 70
  daemon/Relay/Worker tests, 20 registry tests, and a final 33-test focused transport/reconnect set
  all green after the narrow ordering fix. The Remote availability SSOT, AppWorkspace gates,
  Team async containment, strict connected-only usage polling, and disabled DataPanel reads then
  passed 45 focused renderer tests plus full typecheck/architecture boundaries. T4 then passed 14
  dialog tests covering empty, one/many, long-copy, overflow, busy, recovery, credential-import,
  rejected-selection, and inline lifecycle actions; full typecheck and `git diff --check` remain
  green. T6 then passed its 21-file / 138-test authority matrix; the subsequent Team idempotency
  regression passed 4/4. Typecheck/architecture boundaries, `git diff --check`, and the
  modified-production-file size audit remain green (all changed production TS/TSX files are at or
  below 500 lines).
- Dirty state: clean; generated build/package outputs and `node_modules` are ignored.
- Remaining uncertainty: none for transport or session-summary protocol; the existing bounded
  Remote summary is sufficient for honest shared presentation.
- Unfinished by explicit closure: user installation of the `8b67c4a9` DMG, non-invasive live
  acceptance, real Claude/Codex checks, and Feishu preparation. A future request may resume these
  from this archive; no live process or server deployment was changed during closure.

## Final handoff

No active implementation task remains. If the user later resumes acceptance, start from the exact
`8b67c4a9` package evidence recorded above, confirm what version is installed, and run only the
unclaimed T9/T10 checks. Do not infer that the prior DMG was installed or that Feishu credentials
were configured.
