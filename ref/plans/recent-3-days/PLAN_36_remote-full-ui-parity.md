---
title: Remote full UI parity and safe file presentation
status: delivery-complete-awaiting-installed-acceptance
created_at: 2026-08-11
updated_at: 2026-08-12
completed_at: 2026-08-12
related_changelog: CHANGELOG_592
related_review: REVIEW_233
base_commit: 3ec408aff18c85bdbd4ebb839d4e63a9dbf056e4
delivery_branch: main
delivery_commit: dc4943bb0d620d2ec7dd6013a33c62a32e6ec12a
evidence:
  - ref/evidence/remote-full-ui-parity-audit.md
  - ref/evidence/remote-full-ui-parity-deep-review-manifest.md
---

# PLAN_36_remote-full-ui-parity: Remote Full UI Parity and Safe File Presentation

## Goal

Make every Remote desktop surface structurally and behaviorally consistent with its Local
counterpart while preserving Remote Core/Worker authority. Fix the live transport/reconnect and
Remote lifecycle defects first, audit every page and sub-flow, then implement the complete parity
batch with a strict read-only and secret-hiding boundary for Remote files.

## Invariants

1. Remote never falls back to Local sessions, teams, issues, usage, provider configuration, assets,
   files, permissions, or Workspace data.
2. Remote file content is read-only. No Remote Finder/reveal/edit action is presented.
3. Provider credentials, connection credentials, private keys, tokens, authentication stores, and
   raw Claude/Codex/Grok core configuration files are never listed, read, returned, or rendered.
   A permissions page may expose only a bounded allowlisted effective-permission projection with
   secrets and sensitive paths removed.
4. Capability flags cannot authorize a request while the selected source is unusable. Every async
   result is fenced by profile, Core identity, Worker generation, sequence, and relevant revision.
5. Local and Remote use the same presentation structure wherever the underlying capability exists.
   Unsupported Remote behavior is omitted or accurately disabled, never faked.
6. Session-detail tabs remain Activity, Tasks, Changes, Summary, Cross-session, and Permissions.
   Do not reintroduce Pending or Runtime detail tabs. Pending stays global; runtime controls stay by
   the composer.
7. Adapter-native options remain distinct and strictly validated.
8. Do not signal, kill, Inspector-inject, restart, overwrite, reinstall, or directly manipulate the
   running desktop or Worker. Deployment mutations use official scripts only after a reviewed,
   clean, pushed commit; the user installs the desktop package.
9. Temporary logs, credentials, probes, database copies, and raw audit evidence never enter Git.
10. Production TypeScript files remain below 500 lines; shared UI primitives are preferred over
    duplication.

## Confirmed User Decisions

| Decision | Status | Constraint |
|---|---|---|
| Full page scope | confirmed | Audit and align all Local/Remote UI pages and sub-flows, not isolated screenshots. |
| Audit execution | confirmed | Group pages and dispatch read-only sub-sessions; persist the consolidated result before fixes. |
| File access | confirmed | Remote files are read-only. |
| Sensitive provider configuration | confirmed | Hide Claude/Codex/Grok core config and any file that may contain connection/authentication secrets. |
| Engineering sequence | confirmed | Inventory, grouped audit, durable matrix, implementation, full validation, review, push, package, installed acceptance. |

## Page Inventory

### Main navigation and header

- Header totals, activity/waiting counts, token rates, source selection, page selection, global
  actions, connection state.
- Live, Pending, History, Teams, Issues, and Data.

### Session detail

- Header/source/metadata/context window.
- Activity, Tasks, Changes, Summary, Cross-session, Permissions.
- Runtime controls, composer, image input, interrupt, handoff, loading/offline/error/reconnect states.

### Global dialogs and sub-flows

- New Session and Remote Workspace directory selection.
- Remote connection manager and credential import/edit/delete lifecycle.
- Settings: General, Claude Code, Codex CLI, Grok Build, Worker configuration, Hooks, and the
  explicitly desktop-local appearance/notification/log partition.
- Assets: Skills, Agents, Application Conventions, adapter sub-tabs, injection state, content
  viewer, and Local-only editing/reveal behavior.
- Team detail/member/event/task/message/pending flows.
- Issue detail/edit/delete/restore/resolve/new-session flows.
- Pending approval and plan-review flows; History detail navigation.

## Current Runtime Evidence

- Installed desktop build `3ec408aff18c` exactly matches clean `origin/main`.
- A fresh Remote connection initially established a stable SSH process without replay-gap or
  duplicate-response errors.
- `usage.tokens.get` later exceeded its deadline; ten seconds later the protocol heartbeat pong
  timed out. The transport entered reconnecting and subsequent SSH children repeatedly exited 255.
- AWS Relay Server official `--verify` is healthy and TCP/22 is reachable.
- Official Relay Worker `--verify` fails. Direct read-only checks show the Worker and Provider
  Supervisor processes are running; the configured Grok credential is expired, which independently
  fails the Supervisor credential check but does not yet explain the earlier Worker request stall.
- Worker-to-Relay SSH is currently established while desktop-to-Relay SSH is absent.
- The authoritative Worker database contains 20 unarchived sessions: 19 `active-finished`, one
  `active-working`, and zero `dormant`. The renderer already has Active/Dormant sections, so the
  missing Remote separation is a Worker lifecycle-authority gap rather than a CSS-only defect.
- Remote session Permissions is currently an explicit unsupported placeholder while Local renders
  adapter-specific effective permissions.

## Sensitive File Policy

### Never enumerate, read, transport, or display

- SSH identities, `known_hosts` credential material, Agent Deck connection credentials.
- Provider authentication/token stores, including Claude, Codex, Grok, xAI, gateway, or OAuth
  credential files.
- Raw provider core configuration likely to contain credentials or endpoints, including Claude
  settings/auth files, Codex `config.toml`/`auth.json`, Grok config/auth/active-session metadata,
  environment files, deployment runtime JSON, and Supervisor credentials.
- Worker private runtime/config/state paths and raw environment values.

### Allowed only through bounded projections

- Effective sandbox/approval/permission mode and capability booleans.
- Workspace-relative allow/deny rules whose values pass a dedicated secret/path redactor.
- Adapter/model/runtime labels already authorized by existing Remote contracts.
- File-change content inside the authoritative Workspace, read-only, with canonical-path and size
  fences.

## Approved Read-only Audit Batch

All sessions use Agent Deck `spawn_session`, `codex-cli`, `gpt-5.6-sol`, xhigh thinking, fresh
context, `never` approval, read-only sandbox, team `remote-ui-parity-audit`, and no file writes.

| Group | Tier | Scope |
|---|---:|---|
| A | T1 | Transport, source selection, availability, header, reconnect, and Worker lifecycle. |
| B | T2 | Live/Pending/History, lifecycle sections, cards, hierarchy, pagination, and navigation. |
| C | T1 | Session detail and file-security model, especially effective Remote Permissions. |
| D | T2 | Teams, Issues, Data, all page-local sub-flows, polling, and source fences. |
| E | T2 | Settings, Assets, New Session, Workspace picker, connection manager, and global dialogs. |

Each report must provide a Local/Remote matrix, concrete source evidence, findings by severity,
recommended write boundaries, regression tests, unreadable scope, validation performed, and proof
that the worktree status is unchanged.

## Execution Tasks

### T0 — Isolation and plan

- [x] Freeze clean base `3ec408aff18c` in an Agent Deck worktree.
- [x] Create branch `codex/remote-full-ui-parity`.
- [x] Confirm the page inventory and user-owned security decisions.
- [x] Obtain approval for the five read-only dispatch envelopes.
- [x] Create this durable active plan.

### T1 — Grouped read-only audit

- [x] Dispatch groups A–E with the approved exact controls.
- [x] Receive and adjudicate every report; no session remains active after its result is consumed.
- [x] Independently verify material findings and source/data-authority claims.

Dispatch records:

| Group | Session id | First reply anchor |
|---|---|---|
| A | `019ff415-6fdf-7c13-be99-798bb1cff065` | `463dc40b-d8af-4f17-9d8c-ac7231180c26` |
| B | `019ff416-3fd2-7771-b0ce-ba92cd36f8f6` | `95f90ffd-a985-43e2-8caa-875bc678eec4` |
| C | `019ff416-4189-76b1-860e-d849d110cdb9` | `59de949a-7dd0-427c-b7aa-ef4035bf764c` |
| D | `019ff416-43de-7363-bfa9-bf0ef58c788d` | `b168688b-caa3-46bf-929d-187e8c228663` |
| E | `019ff416-466a-7bd1-a68e-9bcf13ee0a7e` | `68356b43-5c6e-4c4a-aa2c-900f50513ace` |

Audit receipt state:

| Group | Report | Task/session cleanup | Lead adjudication |
|---|---|---|---|
| A | received | completed/closed | transport liveness boundary, lifecycle omission, admission and polling findings accepted |
| B | received | completed/closed | lifecycle, Live contract, Pending aggregate, History and raw fallback findings accepted |
| C | received | completed/closed | effective Permissions design and detail file/value security findings accepted |
| D | received | completed/closed | Local bridge, revision storm, stale confirm, Issue and Data findings accepted |
| E | received | completed/closed | safe session catalog, hook DTO, asset deny policy and dialog findings accepted |

### T2 — Durable audit matrix and design

- [x] Write and archive the complete page/sub-flow matrix as
  `ref/evidence/remote-full-ui-parity-audit.md`.
- [x] Record the sensitive-file allow/deny contract and bounded Remote Permissions DTO design.
- [x] Convert every accepted difference into a work package, acceptance check, and write boundary.
- [x] Update this plan before implementation.

Implementation package order:

1. **W1/T3:** deterministic transport liveness, connected-only admission, single-flight refresh,
   Worker lifecycle.
2. **W2/T5/T7 security foundation:** sensitive file/value policy, safe provider catalog and hook
   projection, additive protocol capabilities.
3. **W3/T4:** Live/Pending/History authority and shared list/tree presentation.
4. **W4/T5:** effective Permissions, Cross-session, detail offline/error/queue/runtime parity.
5. **W5/T6:** Local bridge isolation and Teams/Issues/Data convergence.
6. **W6/T7:** Settings/Assets/New Session/Workspace/connection-dialog convergence and
   accessibility.

### T3 — Transport and lifecycle foundation

- [x] Reproduce and fix the usage deadline/heartbeat/reconnect failure without weakening protocol
  integrity or hiding conflicting/unknown messages.
- [x] Stop overlapping/manual connect storms and make retry state bounded and comprehensible.
- [x] Add Worker-authoritative lifecycle advancement matching Local policy, configuration, and
  event semantics; prove Active/Dormant separation with real DTOs.
- [x] Restore official Worker verify; treat expired optional Grok credentials as a separate explicit
  configuration state rather than a generic Worker failure if product policy permits.

### T4 — Shared navigation and list parity

- [x] Align header state, main page availability, Live/Pending/History structure, session card/tree
  hierarchy, counts, scrolling, pagination, and empty/loading/error/offline states.

### T5 — Session detail and safe Permissions

- [x] Align all six detail tabs and surrounding controls.
- [x] Add Worker-authoritative, bounded, allowlisted effective-permissions projection.
- [x] Prove forbidden provider/core credential/config files are neither scanned nor returned.
- [x] Keep Workspace file changes read-only and canonically fenced.

### T6 — Teams, Issues, and Data

- [x] Align layouts, supported interactions, aggregates, polling, errors, and source identity fences.

### T7 — Settings, Assets, creation, and connection dialogs

- [x] Align shared structure while preserving explicit desktop-local settings.
- [x] Keep Remote assets and conventions read-only with no Finder/edit action.
- [x] Apply the sensitive-file exclusion policy to all asset/configuration surfaces.
- [x] Align New Session, Workspace picker, and connection-manager behavior.

### T8 — Validation and review

- [x] Focused contract/runtime/renderer/race/security/performance tests.
- [x] Typecheck, full Electron suite, production build, Linux/deployment checks, Relay static check,
  macOS Worker sandbox verification, diff hygiene, file-size and review-expiry gates.
- [x] User-confirmed heterogeneous paired deep review; fix and re-review all admissible findings.

### T9 — Delivery and installed acceptance

- [x] Commit/push, verify clean `origin/main` alignment, and mutate deployment only through official
  scripts if changed artifacts require it.
- [x] Build the exact macOS package from delivery commit `dc4943bb`.
- [ ] User installs that exact package.
- [ ] Non-invasively accept connection/reconnect, all page groups, sensitive-file exclusions,
  Active/Dormant lifecycle, and real Claude/Codex sessions.

## Execution State

- **Current stage:** T9 installed acceptance. Source delivery and exact-package construction are
  complete; T8 is closed with paired P1/P2/P3/I1 convergence and no open material finding.
- **Last completed meaningful action:** Delivery commit `dc4943bb` was fast-forwarded to `main`,
  pushed to `origin/main`, and packaged. The obsolete feature branch was removed locally and
  remotely. Final review, changelog, audit, and review-manifest evidence are archived.
- **Last validation:** the full Electron-as-Node suite passes 943 files / 6,043 tests with three
  explicitly conditional live/environment tests skipped. Final reviewers independently passed 22
  files / 117 tests and 26 files / 154 tests. Direct Node and Web TypeScript, architecture,
  Core/Node boundaries, production build, Linux headless verification, deployment automation,
  Relay and Full static checks, diff hygiene, touched-file size gates, and review expiry pass.
- **Next action:** the user installs the exact `dc4943bb` package; then run non-invasive Remote
  History and provider-quota acceptance against that installed desktop and Worker.
- **Open blockers:** none for source delivery or packaging. Installed acceptance waits only for the
  exact delivered package to replace the older installed build.
- **Operational note:** do not click Connect repeatedly while diagnosis is active; overlapping manual
  attempts obscure the reconnect state and can amplify SSH 255 churn.

## Archive status

Implementation, validation, heterogeneous paired review, source delivery, and exact-package build
are complete. The plan is archived while the final installed acceptance remains pending. Durable
audit and paired-review evidence live under `ref/evidence/`; the former `.ref/` workspace copies
have been removed.
