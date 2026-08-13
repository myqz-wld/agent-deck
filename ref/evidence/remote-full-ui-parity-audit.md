---
title: Remote full UI parity grouped audit
status: complete
created_at: 2026-08-11
updated_at: 2026-08-11
base_commit: 3ec408aff18c85bdbd4ebb839d4e63a9dbf056e4
plan: ref/plans/recent-3-days/PLAN_36_remote-full-ui-parity.md
---

# Remote Full UI Parity Grouped Audit

## Status

This is the durable consolidation record for the approved five-group read-only audit. Groups A–E
all returned, were adjudicated, and their tasks and sessions were closed after receipt.

The working tree stayed clean at the frozen base throughout the completed audits. No audit session
opened live credentials or raw provider configuration, mutated files, operated processes, installed
dependencies, or performed deployment.

## Fixed Product and Security Boundaries

1. Remote never falls back to Local data or actions.
2. Ordinary Remote business calls require a currently connected and usable authority; retained
   capabilities from an old binding never authorize new work.
3. Remote file presentation is read-only. Finder, reveal, edit, and open-external actions are Local
   only.
4. Claude, Codex, Grok, gateway, SSH, deployment, Supervisor, and Worker private configuration or
   credential files are never enumerated, opened, transported, logged, or rendered.
5. Sensitive exclusion happens before reading a file. Content redaction after reading is not an
   acceptable substitute.
6. Remote Permissions uses a purpose-built bounded effective-policy projection. It never reuses
   Local filesystem scanners or their raw/path-bearing DTOs.
7. Session-detail tabs remain Activity, Tasks, Changes, Summary, Cross-session, and Permissions.
   Pending stays global and runtime controls stay next to the composer.
8. Unsupported behavior is accurately unavailable. It is not filled with Local data or represented
   as a successful empty result.

## Consolidated Page Matrix

| Page or flow | Local authority and presentation | Remote baseline | Required convergence |
|---|---|---|---|
| Header/source | Full Local totals, activity, pending, tokens, navigation | Remote source is isolated, but tabs may remain enabled offline and activity/pending counts cover only loaded rows | Gate by usable plus capability; use authoritative aggregate counts or label partial counts |
| Connection state | Local not applicable | One SSH child, bounded reconnect; generic exit 255 and repeated equivalent state emissions | Connected-only business admission, bounded diagnostics, no overlapping UI mutations, truthful reconnect/offline state |
| Live | Rich card, active/dormant, team/spawn tree, pin/order, metadata | Renderer already has active/dormant sections; Core produces no timed dormant rows; flat thin cards and offset pages | Headless lifecycle authority; typed rich safe summary; stable keyset/snapshot list; shared tree/card primitives |
| Pending | Complete Local store, rich group headers, structured rows, batch actions | N+1 hydration over first loaded Live page; can show false empty; failures are silent; stale hydration may overwrite newer state | Core aggregate pending index/list, loading/error/partial/cursor state, monotonic merge, bounded RPC count |
| History | Server-side search/filter and complete record/actions | Client filters only loaded thin summaries; archive bit lost; offset pages drift; load-more errors hidden | Safe history projection, server-side query/keyset cursor, independent pagination state, accurate archive state |
| Session Activity | Shared activity renderer with Local event authority | Remote events are bounded and source-fenced | Apply central sensitive-key/value/path projection; never render raw fallback JSON/errors |
| Session Tasks | Local task repository | Remote Core task repository, shared renderer | Preserve current authority/fences; align per-panel error and retry states |
| Session Changes | Local file-change repository and Local file actions | Remote bounded read-only file diff/content APIs | Canonical Workspace root plus explicit sensitive-file deny policy before list/get/final-diff/image authorization |
| Session Summary | Local summary repository | Remote bounded Core summary list, shared renderer | Preserve; give failures a panel-local state |
| Session Cross-session | Local message database and shared message view | Unsupported placeholder | Add a separate bounded read-only message capability and DTO; never use Local message DB |
| Session Permissions | Local raw Claude/Codex scanners, paths, raw config, open actions | Unsupported placeholder | New effective-policy projection only; no paths, raw text, config existence, scanner, Finder, or reveal |
| Session runtime/composer | Adapter-native controls and queued input visibility | Worker-authoritative controls/send/steer/interrupt/handoff | Disable restart-sensitive controls/handoff during active turns; add queue visibility; render null as provider-default/unavailable |
| Detail offline/loading | Local not applicable | Source clears detail fail-closed, but disconnected state can look like indefinite loading | Explicit connecting/reconnecting/Worker-offline/offline/incompatible/not-found shells |
| Teams | Local team data and nested member/event/task/message/pending flows | Shared presentation and Core authority exist; full-detail refresh is globally over-triggered and deferred confirms can use a stale source | Entity-scoped refresh, post-confirm authority recheck, connected-only admission, shared source-neutral view |
| Issues | Local issue list/detail/mutations/new-session flows | Shared board/detail fields with strong result fences; only first 100 rows, Local bridge still mounted, claim-release and structural dialog gaps | Local bridge isolation, pagination/total, definitive claim release, shared expanded editor and creation form |
| Data | Local live/rates/daily/provider usage | Remote ledger/provider DTOs are authoritative; polling overlaps, unrelated revisions trigger full history, failures resemble zero, live copy is inaccurate | Single-flight resource-scoped refresh, error/loading/last-success states, accurate source-aware copy, scoped 10m provider refresh |
| Settings | Desktop settings plus provider/hook configuration | Correctly separates desktop-local appearance from Worker data; Remote hook status leaks Worker path/raw hook identifiers | Dedicated sanitized Remote hook status; split/read-mutate support; assert adapter identity |
| Assets/conventions | Local content plus reveal/edit where supported | Remote is read-only and has no Local fallback | Explicit sensitive-file deny classes, immutable list-to-view binding, safe labels, bounded/fair rendering |
| New Session | Local adapter capabilities and directory picker | Worker capability/Workspace authority is correct, but discovery opens raw provider config and mutation target/cancel UX is weak | Adapter-owned safe catalog snapshot; immutable Remote target badge; truthful in-flight close/cancel state |
| Workspace picker | Local filesystem picker | Remote Workspace-relative browser | Preserve Core authority and stale fences; never expose absolute Worker paths |
| Connection manager | Desktop-local profile/material control plane | Public DTO redaction is sound; UI can overlap mutations and retain stale edit state | Serialize per-profile operations, operation ids/counters, reset/revalidate form lifecycle |

## Accepted Findings

### Transport and authority

#### A-H1 — Shared Remote stream lost liveness

The 45-second `usage.tokens.get` deadline was followed ten seconds later by a heartbeat pong timeout.
The daemon handles ping directly, so a slow usage query alone does not explain the missing pong.
The smallest proven boundary is a Worker event-loop or shared Relay/Worker/client output-progress
failure. The later SSH exit 255 cause remains unproven because current diagnostics discard the
useful admission/forced-command category.

Implementation boundary:

- Reserve control-frame progress ahead of unsent business traffic.
- Add bounded write-progress timeout and hop-specific sanitized categories.
- Keep unknown/conflicting protocol frames fatal.
- Add deterministic stalled-response and blocked-writer fixtures before changing recovery policy.

#### A-H2/B-H1 — Worker omits lifecycle scheduling

Local bootstrap starts `LifecycleScheduler`; Server Core/Local Worker composition starts no
time-authoritative counterpart. The renderer already renders Active and Dormant. The authoritative
database therefore leaves finished sessions Active indefinitely.

Implementation boundary:

- Add an Electron-free Server Core lifecycle component with injected clock, repositories, metadata
  publisher, provider-close and cleanup ports.
- Share versioned 1h Active→Dormant, 24h Dormant→Closed, and 30d history-retention defaults.
- Use CAS/revision fences and start/stop the component through runtime composition.

#### A-H3 — Main service admits new work while unusable

`RemoteHostService.beginScope` accepts `reconnecting` and recoverable Worker-offline bindings even
though renderer availability requires `connected`. Stale capabilities can therefore authorize new
ordinary business work in a race or direct IPC call.

Implementation boundary: ordinary calls are connected-only. Any retained transport recovery or
terminal-result exception must use an explicitly named narrow path with existing idempotency rules.

#### A-M1 — Usage polling amplifies outages

The 2.5-second timer starts asynchronous token calls without a single-flight guard. A 45-second
stall can overlap about eighteen calls, plus revision-driven refreshes.

Implementation boundary: coalesce to one in-flight request, cancel/retire on authority change,
bound revision refreshes, and surface a page-local error.

### Live, Pending, and History

#### B-H2 — Live summary/list contract cannot express Local parity

Remote summaries contain only id, adapter, title, opaque status, and timestamps. They cannot express
the Local team/spawn tree, pin order, source/role, model/thinking/branch/context, activity, summary,
or safe project label. Offset pagination cannot guarantee parent/lead closure.

Implementation boundary: introduce a typed bounded summary/list contract with explicit lifecycle
and activity enums, safe presentation metadata, relationship closure, per-section totals, stable
sort, and snapshot/keyset cursor. Render Local and Remote through one source-neutral presentation
tree while capability-gating mutations.

#### B-H3 — Pending is incomplete N+1 hydration

Remote Pending scans only currently loaded Live summaries and waits for waves of per-session calls.
It has no authoritative loading/error/cursor state and can show false empty or allow older hydration
to overwrite a newer mutation/detail refresh.

Implementation boundary: add a Core aggregate pending index/list with session presentation,
snapshot/revision, cursor and total. Empty state is legal only after an authoritative completed
response. Merge per session monotonically and keep request count proportional to page count.

#### B-M1..M4 — History/pagination/navigation/status gaps

- Preserve explicit archived state and search on the Core, including later pages and safe activity
  fields.
- Use stable snapshot/keyset cursors; keep Live and History pagination/error state independent.
- Clear or origin-scope History detail when navigating to Live.
- Reject unknown lifecycle/activity values instead of mapping them to Active/idle.
- Distinguish authoritative totals from loaded counts.

#### B-M5 — Pending fallback can render sensitive raw JSON/error text

Unknown or malformed pending presentations must use fixed natural Simplified Chinese copy and
allowlisted fields only. Raw `JSON.stringify(display)` and backend error text must not enter the DOM.

### Session detail and file security

#### C-H1 — Changes lacks an explicit sensitive-file deny policy

Remote file-change list/get/final-diff currently relies on lexical Workspace containment and size
bounds. It can return recorded content for provider/auth-looking files beneath Workspace and does
not prove the session cwd against a canonical Workspace identity.

Implementation boundary: one central classifier must reject sensitive basenames/categories,
provider configuration/auth trees, environment/key material, private roots and canonical escapes
before any content lookup. Apply it consistently to list, get, final diff and image authorization.

#### C-H2 — Event/change metadata projection fails open

Only narrowly recognized path/diff keys receive special handling. Secret-like values under benign
or deceptive keys and unknown private paths may pass through.

Implementation boundary: central allowlisted projection classifies keys and values, rejects token,
Bearer/JWT/PEM/key-value secret shapes and absolute/private paths independent of field name, and
returns fixed omission categories rather than raw errors.

#### C-H3/C-H4 — Local Permissions is forbidden and Remote functionality is absent

Local permission DTOs carry cwd, absolute paths, exists flags, raw configuration, parse/read errors,
and open actions. Reusing them remotely would violate the fixed boundary. Remote Permissions and
Cross-session are currently placeholders.

Required Remote Permissions design:

- Additive protocol capability and one exact desktop-full read method keyed only by `sessionId`.
- Return session id, adapter, revision, effective adapter-native enum values with explicit
  session/workspace/core-default/provider-default/unavailable provenance, bounded workspace
  read/write/network state, and at most 200 structured tool/workspace-subtree rules.
- No cwd, path, filename, exists flag, raw text, config/auth/environment data, scanner error,
  arbitrary command argument, endpoint, model derived from config, Finder/reveal/open/edit action,
  or filesystem scanner dependency.
- Populate from a narrow trusted in-memory/persisted effective-policy port. If no projection was
  captured, report unavailable; never scan to infer it.
- Fetch lazily on the active tab with identity/session/revision single-flight fencing. Old Core
  performs zero request and shows an accurate unsupported state.

#### C-M1..M5 — Detail interaction and error gaps

- Disable handoff and restart-sensitive runtime mutations during active/waiting provider turns.
- Present explicit disconnected/reconnecting/offline/incompatible states while keeping data/actions
  cleared fail-closed.
- Add bounded queued-outgoing visibility.
- Render null runtime policy as provider-default/unavailable, not a fabricated concrete value.
- Give context/input/runtime/pending failures panel-local state and retry ownership.

### Settings, Assets, creation, and connections

#### E-H1 — New-session discovery opens forbidden raw provider configuration

The current Server Core capability path invokes provider defaults/gateway/profile discovery that
opens Claude settings, Codex config and Grok config. Sanitizing the eventual DTO does not satisfy
the rule that these files must never be read for Remote UI discovery.

Implementation boundary: adapters publish a bounded safe session-capability/catalog snapshot from
trusted runtime composition. The request path has no generic filesystem parsing and negative tests
fail if forbidden config/auth paths are opened.

#### E-H2 — Remote hook status leaks Worker-private material

The Remote DTO carries `settingsPath` and raw `installedHooks`; the UI renders the path.

Implementation boundary: a dedicated Remote hook status contains only bounded supported,
installed/partial, scope, writeAllowed and sanitized disabled reason. Split read/status authority
from mutation authority and assert echoed adapter id at Core, Main and renderer boundaries.

#### E-H3 — Asset discovery lacks explicit sensitive exclusion

Positive root and canonical fences are present, but manifest-declared Markdown/TOML assets can be
accepted without a sensitive basename/category policy.

Implementation boundary: exact asset shapes plus an explicit deny policy before stat/read/catalog
insertion, including manifest and symlink targets. Forbidden fixtures must be neither opened, listed
nor retrievable.

#### E-M2..M6/L1 — Asset/dialog lifecycle, scale and accessibility

- Bind list cards to content with opaque asset id/digest and expected catalog revision; assert
  adapter/revision echoes and close or refresh stale viewers.
- Show immutable Remote target identity during create; make close/cancel semantics truthful after a
  mutation is sent.
- Serialize connection mutations per profile and reset/revalidate editor state on close/reopen.
- Render Core-supplied unavailable option rows instead of silently removing disabled fields.
- Paginate/virtualize/fairly budget assets; wrap bounded long content; never substitute an absolute
  Worker resource path into content.
- Add dialog semantics, focus trap/restore, scroll containment and narrow/long-copy coverage.

### Teams, Issues, Data, and Local bridge isolation

#### D-H1 — Remote mode still consumes Local business stores and IPCs

`App` mounts Local event, Issue and startup Data bridges before source mode is known. Remote views
also instantiate hooks that subscribe to Local session, Issue and token stores even when the values
are normally not rendered. This is not a visible fallback in the current branch, but it violates
the zero Local business-call/store-consumption boundary and wastes work during Remote failure.

Implementation boundary:

- Mount Local bridges only inside a Local-authority subtree after source selection is known.
- Split Data, Issue and Team Local adapter wrappers from source-neutral presentation components so
  a Remote branch subscribes to no Local business store.
- During initial unknown, Remote, reconnecting, offline, incompatible and unsupported states, tests
  must prove zero Local Issue/token/provider/session calls and zero Local store mutations.

#### D-H2 — Global data revision creates request storms

Every Core event advances one global revision (batched only for 200 ms). Remote usage, Issue and Team
hooks react to it without resource classification or cancellation. An active Data tab can therefore
repeat a 5,000-row daily query for unrelated session/team/issue events while the 2.5-second timer
also accumulates slow token calls. Team detail additionally aggregates pending across active members.

Implementation boundary: add a resource-scoped refresh broker keyed by authority identity and
resource kind, with one in-flight request plus one dirty follow-up. Completion-scheduled polling or
abort/retirement replaces bare intervals. Core events carry resource-specific invalidation; usage
daily reacts only to usage changes or explicit refresh.

#### D-H3 — Deferred Team confirmation can send through a stale source

Team destructive handlers capture the old source before awaiting the native confirmation dialog.
Unmount/source change does not retire that closure, and main admission currently accepts
reconnecting/Worker-offline states. A confirmation returned after disconnect or identity switch can
therefore start a new Remote mutation.

Implementation boundary: after confirmation, re-read current identity, usability and capability;
increment an action epoch on unmount/source/team change; perform zero mutation when stale. Main
connected-only admission remains the authoritative second fence.

#### D-M1/D-M4 — Issue pagination and structural presentation diverge

Remote Issue list always requests offset 0/limit 100 despite contract support for offset and
truncation. Local and Remote also use different expanded text and resolve-in-new-session dialog
structures.

Implementation boundary: add cursor/offset load-more plus total/truncated state while preserving
selected detail, and converge both modes on the same expanded editor and `NewSessionForm`; source
capabilities govern attachments, directory selection and adapter options rather than branching the
whole layout.

#### D-M2 — Issue mutations leak definitive idempotency claims

Issue mutation code claims before executing but does not release the claim when validation/not-found
fails before a mutation, or when resolution session rollback is proven complete. Team runtime
already contains the correct release pattern.

Implementation boundary: add `releaseMutationClaim` to the Issue metadata port. Release only for a
proven definitive failure or completed rollback; retain the claim when side effects are uncertain.
Tests cover replay, retry and ledger growth.

#### D-M3 — Remote Data refresh, real-time and failure semantics are misleading

Remote rate errors are swallowed, initial/error totals render as zero, provider quota does not keep
the Local ten-minute freshness cadence, and copy claims a live estimate despite Remote having only a
rolling ledger window.

Implementation boundary: expose loading/error/last-success for rates and daily data, render unknown
as `—`, add identity-scoped single-flight provider refresh, and use accurate Remote rolling-window
copy unless a bounded live-tick projection is introduced.

#### D-M5 — Team/Issue free text lacks sensitive-value proof

Known private roots are replaced, but agent-authored titles, descriptions, reproduction text,
messages and task text have no secret-like value projection. The fixed product decision is to apply
the same bounded sensitive-value projector to every Remote-rendered free-text field. This protects
accidental credentials while preserving ordinary user text with explicit omission markers.

## Security Contract Tests

The implementation must include negative tests proving all of the following:

- No request-time reads of `.claude`, `.codex`, `.grok`, auth/token/credential/key/environment,
  gateway, deployment, Supervisor or Worker-private configuration stores.
- Sensitive nested/case/Unicode/symlink aliases are excluded before content read.
- Token-like values (`sk-`, Bearer, JWT, PEM/private-key headers, high-entropy values, `KEY=`,
  `TOKEN=`, `SECRET=`) do not survive event, metadata, permissions, pending or error projection even
  under deceptive field names.
- Absolute paths, traversal, encoded traversal, control bytes, outside-Workspace canonical paths,
  private roots and root-swap races fail closed.
- Remote UI calls no Local asset, file, permissions, provider configuration, team, issue, usage,
  session or message API on old Core, disconnect, malformed result or missing capability.
- Remote content surfaces expose no reveal/Finder/open/edit callback.

## Required Race and Performance Tests

- Stalled business response while the runtime remains responsive still returns pong.
- Blocked output cannot starve control progress; reconnect attempts remain single-child and bounded.
- New ordinary work is rejected during reconnect/Worker-offline despite retained capabilities.
- Token polling has at most one in-flight request and retires on source identity change.
- Lifecycle fake-clock startup catch-up, thresholds, pin/recent exclusions, CAS races and restart
  idempotency produce authoritative Active/Dormant/Closed list output.
- Live tree closure and totals survive 40/41 boundaries and concurrent activity.
- Pending after page 40 is visible; no false empty; slow/old results cannot overwrite newer state.
- History search finds later-page safe fields and pagination does not omit moved rows.
- Permissions/assets/settings/detail replies are rejected across profile/Core/generation/session/
  adapter/revision changes.
- Maximum profile, asset, rule, event, diff and long-copy fixtures remain bounded and usable.

## Implementation Work Packages

| Package | Scope and ordering | Primary write boundary |
|---|---|---|
| W1 | Transport liveness fixture, connected-only admission, single-flight polling, Worker lifecycle | SSH/daemon/Remote service/usage hooks/Server Core lifecycle composition |
| W2 | Central sensitive file/value policy, safe provider catalog and hook DTO, protocol capability additions | contracts, protocol handshake, Core projections/catalogs, Main parsers |
| W3 | Live/Pending/History authority and shared list/tree presentation | session summary/list/pending/history Core and renderer source |
| W4 | Effective Permissions, Cross-session read, detail offline/errors/queue/runtime controls | new detail contracts/Core ports/Main/preload/source/shared tab views |
| W5 | Local bridge isolation and Teams/Issues/Data convergence | App authority subtree, Team/Issue/Data sources, Issue claim lifecycle |
| W6 | Settings/Assets/New Session/Workspace/connection dialog and accessibility | source-neutral dialog primitives and bounded asset/content lifecycle |

W1 is the mandatory foundation. W2 precedes any new file/config UI. W3–W6 consume only the
authority and projection contracts established by W1/W2.

## Validation Record So Far

- Final implementation validation before paired review: 930 Electron test files and 5,948 tests
  passed, with two files and three tests conditionally skipped. Typecheck, production build, Linux
  headless, deployment automation, Relay static checks, macOS Worker sandbox, bundled runtimes,
  logger, architecture, diff hygiene, file size, and review-expiry gates all passed. No installed
  desktop or Worker process was restarted, signaled, instrumented, or overwritten.

- W6 is implemented and focused-green. Remote asset/configuration reads now use sanitized,
  revision-bound Worker authority; sensitive configuration candidates are rejected before read;
  large asset sets and content are bounded in the DOM; adapter-native disabled creation choices show
  the Core reason; the Remote target is immutable and visible; profile mutations are serialized; and
  all principal/nested W6 overlays share dialog semantics plus focus entry, trapping and restoration.
  Direct Web typecheck and 78 tests in 10 focused files pass, including the pre-existing plan-review
  dialog regression after generalizing nested modal isolation.

- W5 is implemented and focused-green. Remote authority now mounts zero Local session/Issue/Data
  bridge work; Team and Issue views do not subscribe to Local stores; Team confirmation, refresh and
  retry states are identity/usability fenced; Remote Issues paginate and release definitive claims;
  Data polling/provider refresh is single-flight with truthful loading/error copy; and Local/Remote
  Issue resolution shares one form, directory flow and bounded image path. Direct Node/Web
  typechecks, both architecture checks, `git diff --check`, and 166 tests in 19 focused files pass.

- Lead independently confirmed: Server Core lacks the Local lifecycle scheduler; main admission accepts
  reconnecting/Worker-offline states; token polling is not single-flight; Remote Permissions is a
  placeholder; Local Permissions carries raw/path/open data; event projection uses narrow key-name
  recognition; Remote hook status carries and renders `settingsPath`; new-session discovery opens
  raw provider configuration; asset scanning has canonical positive roots but no explicit sensitive
  deny classifier; App mounts Local Issue/Data bridges before source authority is known; Team
  mutations capture a source across confirmation; Issue list is fixed at 100; Issue mutations lack
  the Team runtime's definitive claim-release path; Data loading/error/live copy is ambiguous.
- Audit sessions independently passed architecture/core-node boundary checks where their read-only
  environment allowed it. Dependency-backed tests were not available in those sessions, so this
  record does not claim implementation validation.
- At audit time the implementation worktree was intentionally dirty and contained no runtime
  credential, probe, database, deployment state, or temporary evidence. Implementation and paired
  review later converged; the final disposition is recorded in REVIEW_233 and PLAN_36.
