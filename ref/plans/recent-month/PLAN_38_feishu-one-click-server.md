# PLAN_38_feishu-one-click-server: Feishu One-Click Server Connection

Status: Relay live acceptance complete; Full and real Feishu external acceptance pending
Completed At: 2026-08-14
Base commit: `c2a0a1ea4077d67fcfc1ea242d7caae7600b0222`
Owner: user
Implementation authorization: granted by the user on `2026-08-13`; execute continuously through validation and leave the final result for user acceptance
Target branch: `codex/feishu-one-click-server`
Isolation: `./.agent-deck/worktrees/agent-deck-019ffbfd-37c-msrtkmb2` on branch `codex/feishu-one-click-server`

## Phase 0 — Remove Dead Product Surfaces and Expired Compatibility First

Before topology terminology, Server connection policy, CLI, packaging, pairing, or Feishu work, complete the evidence-gated P0 cleanup defined in [`feishu-one-click-p0-cleanup-batch.md`](./PLAN_38_feishu-one-click-server/feishu-one-click-p0-cleanup-batch.md).

After this complete implementation plan is approved for execution, P0 begins with two parallel read-only audits: one isolates code used only by the removed Team/session-permissions pages; the other scans repository-wide compatibility code for paths with no supported purpose. Their reports produce exact, disjoint cleanup manifests. Source deletion happens only in a second batch after producer/consumer, persistence, external-contract, upgrade, rollback, and security-fence evidence is recorded. Early approval of the audit envelopes locks their scope but does not authorize pre-plan scanning.

This ordering is mandatory: Remote Owner Product v1 and Desktop/Feishu parity must be derived from the cleaned current product, not dormant renderer pages or obsolete compatibility surfaces. Active Agent/MCP team collaboration, session-scoped team metadata/messages/tasks, pending permission approvals, runtime permission controls, current-schema integrity, and active security/data-repair paths remain protected invariants.

## Goal

Add a server-owned Feishu connection workflow that turns an already healthy Agent Deck server into a Feishu bot endpoint with one installed management CLI, one dedicated connection credential, deterministic health verification, and a safe first-user pairing flow. Connection lifecycle belongs to the Server control plane; a Relay Worker remains the business-data and compute owner but does not issue, list, pair, rotate, or revoke client connections.

The intended steady-state topology is:

```text
Feishu Cloud
    | outbound WebSocket + HTTPS
    v
Feishu sidecar on the Agent Deck server
    | restricted server-issued credential
    v
Server connection router
    | Relay: authenticated access context      | Full: local authoritative Core
    v                                           v
Worker-owned Core                         Server-owned Core
```

## Confirmed Scope and Invariants

- Use `standalone`, `relay`, and `full` as the only topology values across product copy, CLI, persisted configuration, exported credentials, and protocol messages. Reserve “Server Core” for the Core component that runs inside Full topology; it is no longer a topology name. Retired topology/schema/surface/protocol forms are rejected and must be reprovisioned because the project has not been released.
- Run Feishu as an independent sidecar on the same Linux host as the Agent Deck Server in both Relay and Full topologies in the first release.
- Put operational connection management in an installed server-side CLI. Credential issuance, export, listing, pairing approval, rotation, revocation, and connection health must not require Worker-local configuration or state.
- Make the Server Connection Authority the source of truth for connection identity and any future permission policy. In Relay topology this authority lives on Relay; in Full topology it lives on the Full server. Do not use “Relay authority” as the topology-independent product term.
- Keep release/bootstrap deployment tooling separate from operational connection management: repository `pnpm deploy:*` commands may install or upgrade a server release, while the installed server CLI owns live connection operations.
- Keep repositories, provider credentials, session transcripts, and business data on the Worker/Core. The Relay host remains a transport and connection-metadata boundary.
- Let the selected Agent Deck Server instance issue a dedicated Feishu SSH credential. Never reuse a Worker or Desktop credential.
- In Relay mode, Worker/Core must not receive human/provider identity, public keys, the credential registry, or revocation history. It may receive an opaque stable connection-scope handle and Server-attested product/capability claims required for persistent subscription/idempotency scope and final request validation. This does not make Worker the connection authority.
- Preserve `surface` as a meaningful Server-assigned connection classification used for routing, policy selection, diagnostics, and future channel-specific permission profiles. Do not hard-code current Desktop/Feishu product differences as different permissions: both resolve to the same Remote Owner Product v1 grant set today.
- Use Feishu long connection for events; do not require a public webhook listener.
- Keep Feishu developer-console operations user-owned: create/select the app, enable the bot, grant permissions, configure long-connection events and card callbacks, publish/install the app, and obtain the app ID/secret.
- Never put Feishu secrets in command-line arguments, process listings, logs, generated connection bundles, or repository files.
- Keep deployment actions explicit and idempotent: `--check`, `--dry-run`, `--deploy`, `--upgrade`, and `--verify`; rollback design is required before implementation.
- Product behavior is deterministic. This integration does not add model calls, prompts, or autonomous decisions.

## Non-Goals for the First Release

- Creating or publishing the Feishu app through browser automation.
- Making a personal consumer Feishu account sufficient when it cannot create/install a custom app. A personal user may operate the bot only inside a tenant where the app is installed and allowed.
- Exposing Core directly to the public internet.
- Moving repository or provider data onto the Relay host.
- Supporting arbitrary Feishu tenants or users without an explicit pairing/allowlist decision.
- Treating a missing Feishu command/card as an authorization boundary. Product entry coverage and Owner authority are separate concerns.
- Moving provider/repository/session ownership from the Worker to Relay.

## Existing Evidence

- `src/gateways/feishu/runtime.ts` already runs the official Feishu SDK long connection and reconciles a fixed app/tenant binding before startup.
- `src/gateways/feishu/mapper.ts` pins app and tenant identities and rejects out-of-scope senders/operators.
- `src/gateways/im/gateway.ts` rejects unknown identities, so a bootstrap `/pair` path does not yet exist.
- `src/hosts/relay/control-host.ts` already requires a `kind: feishu` credential for the restricted Feishu console.
- `deploy/linux/relay/authorized-client-key-options.txt` already contains the Feishu forced-command form.
- `src/hosts/linux-runtime/connection-credential-issuer.ts` and `src/hosts/relay/connection-issuer.ts` already implement the key-generation and atomic authorization pattern, but the current issuer exposes Worker/Desktop-shaped choices rather than a dedicated Feishu issuance path.
- `deploy/linux/relay/README.snippet.md` explicitly requires Worker and Client credentials to be issued entirely on the Relay host; neither Worker nor Desktop generates its own key. Server-side Feishu connection management follows the existing authority rather than creating a new one.
- `src/hosts/server-core/connection-issuer.ts` provides the equivalent Full/Server-Core authority, and both Full and Relay already define exact `desktop-full` and `feishu-session-console` forced-command bindings.
- `src/hosts/feishu/config.ts` already accepts both `relay` and `server-core` topologies, so a shared management façade can reuse the gateway/runtime while dispatching only the topology-specific credential enrollment.
- `deploy/linux/feishu/` contains a service wrapper, unit, examples, preflight, and static checks. Its live Ubuntu/EL9 and real-Feishu acceptance remain outstanding.
- `scripts/deployment/artifacts.mjs` and `scripts/deployment/remote-install.sh` do not package or install the Feishu service today.
- The Feishu bundle currently externalizes `better-sqlite3`; the target host must provide a native module matching its Node ABI. This prevents a truly fresh-host one-command install.
- `node:sqlite` is available without the experimental flag on sufficiently recent Node 22 releases, but Node still classifies it as an active-development API. Treat adoption as an explicit product risk, not a mechanical refactor.

## Proposed User Flow

1. The operator completes the one-time Feishu console checklist and copies the app ID and app secret.
2. The operator signs in to the Agent Deck server's existing administration shell and runs the installed server CLI against an exact local instance. The CLI infers Relay versus Full from server-owned instance metadata rather than trusting a caller-supplied topology flag.
3. The server CLI checks that the A1 Feishu runtime artifact is installed and digest-compatible, then performs an explicit check/dry-run/connect operation. Release installation remains a separate server deployment concern.
4. `feishu connect` creates a dedicated Feishu credential through the local topology authority, writes root-owned/service-readable secret files atomically, installs or activates the sidecar service, and waits for bounded health checks.
5. `feishu verify` proves unit health, outbound Feishu connectivity, the restricted Core surface, and rejection of broader methods. It prints a redacted acceptance checklist for the live Feishu message/card round trip.
6. The Agent Deck server operator runs `feishu pair`. It creates a short-lived code and waits for a candidate through a root-restricted management interface to the sidecar.
7. The intended Feishu user sends `/pair <one-time-code>` to the bot. The sidecar records the candidate `tenantKey + openId` as pending but does not grant Core access.
8. The same server CLI displays a redacted candidate fingerprint and asks the Agent Deck server operator to approve or reject it. “Operator” here does not mean a Feishu tenant administrator; it means a person already authorized to administer this Agent Deck server instance.
9. On approval, the binding is persisted locally in the Feishu sidecar metadata store and the one-time code is invalidated. Rejection or timeout invalidates the pending request without granting access.
10. Normal commands are accepted only from the pinned binding. All other identities receive a non-sensitive denial/pairing response.
11. The first-release Feishu product surface includes session deletion. `/delete` (and any destructive card action) resolves one exact session, presents its identity/title, requires an explicit confirmation action, carries stable idempotency, and reports the authoritative Core result. It uses the same Remote Owner Product v1 deletion grant as Desktop; only the chat interaction differs.

## Route Checkpoint A — Runtime Packaging

The existing `better-sqlite3` dependency is the main one-click packaging gap.

### A1 — Dedicated pinned Feishu runtime artifact (selected)

Keep the proven SQLite store and package a Linux runtime with its matching native binding. The deployer verifies a version/digest before installation. The process still runs under an isolated Feishu service identity.

Benefits: preserves current persistence semantics; avoids an active-development database API; creates a reproducible production artifact.

Costs: adds release/build work for supported Linux architecture and libc targets; artifact signing/digest policy and upgrade compatibility must be specified.

### A2 — Migrate the Feishu store to `node:sqlite`

Raise and pin the minimum supported Node 22 minor and remove the external native dependency from the Feishu bundle.

Benefits: smallest installed footprint and simplest host deployment.

Costs: adopts an API Node still marks active-development; requires a persistence adapter rewrite, migration/compatibility tests, and an Electron/build-boundary check.

### A3 — Require a preinstalled matching `better-sqlite3`

Keep the current service contract and make the operator install a compatible module first.

Benefits: least repository work.

Costs: not genuinely one-click; ABI drift is an operational failure mode. Not recommended.

## Route Checkpoint B — Pairing Authority

### B1 — Code plus local approval (selected)

The installed server CLI generates a short-lived, single-use code and waits. The Feishu user submits it, then the Agent Deck server operator sees the proposed tenant/user fingerprint and explicitly approves it on the server administration shell. The operator need not be the Feishu tenant administrator.

Benefits: prevents a leaked or misdirected code from silently claiming owner-equivalent access; produces an auditable approval event.

Costs: one extra operator action.

### B2 — Code immediately binds the first sender

The first valid sender wins and the code is invalidated.

Benefits: closest to consumer-style one-click onboarding.

Costs: possession of the code is sufficient to claim owner-equivalent access; recovery and race behavior become security-critical. Not recommended.

### B3 — Preconfigure tenant/user IDs

Retain manual `tenantKey + openId` enrollment and use `/pair` only as a diagnostic.

Benefits: strongest explicit binding and smallest gateway change.

Costs: preserves the current discoverability/setup friction and does not meet the requested onboarding experience.

## Route Checkpoint C — First Product Surface

### C1 — Server CLI only for the first release (selected, execution locus refined)

Add an installed server-side operational CLI and documented config/secret-file inputs. The CLI is sufficient for connection issue/export/list/revoke, Feishu connect/verify/pair, and operational diagnostics. Repository `pnpm deploy:*` remains release/bootstrap tooling rather than the normal connection-management interface. No Desktop Settings UI is in the first-release scope.

Benefits: matches the existing server-owned credential authority, gives Relay and Full one lifecycle contract, keeps Worker free of client-registry state, and makes rollback/verification observable.

Costs: the operator needs terminal access once.

### C2 — Desktop Settings wizard in the first release

Add UI for Relay selection, Feishu app inputs, deployment progress, pairing approval, and verification.

Benefits: lowest end-user friction.

Costs: materially expands scope across IPC, copy, secret storage, progress streaming, recovery, and UI testing.

### C3 — CLI and Desktop wizard together

Ship both surfaces against a shared deployment service contract.

Benefits: complete experience in one milestone.

Costs: highest delivery and review risk; delays the independently useful CLI path.

## Route Checkpoint D — Connection Control Plane (selected)

### D1 — Unified installed Server CLI (selected)

Provide one stable management façade on Agent Deck Linux servers. Tentative command families are `connections issue|list|revoke|rotate` and `feishu connect|status|verify|pair|disconnect`. The façade resolves the exact instance and topology locally, then delegates to the existing Relay or Full credential authority.

This does not require one shared business-data store: Relay continues to retain only connection metadata, while Full owns its Core data locally. The shared layer is lifecycle policy, schemas, validation, redaction, and command UX.

### D2 — Remote administration CLI

Run connection management from Worker/Desktop over a new management channel. This duplicates an authority that already lives on the server and creates a new privileged remote surface. Rejected for the first release.

### D3 — Topology-specific ad hoc commands

Add separate Relay and Full Feishu scripts. This is smaller initially but preserves drift and weakens reuse. Rejected.

## Route Checkpoint E — Server-Owned Surface Policy (selected)

Current facts:

- Desktop and Feishu authenticated clients both carry `authority: owner-equivalent`; there is no current per-user role/RBAC distinction.
- `desktop-full` and `feishu-session-console` are nevertheless enforced as real Core method surfaces today. `isCoreMethodAllowed` and the Worker request scheduler reject a Feishu transport that sends methods outside the session-console classification.
- Relay forwards the Core payload as opaque bytes. It authenticates the credential and attaches route metadata, but cannot enforce method-level policy without parsing business protocol payloads and weakening the metadata-only boundary.

### E1 — Server-owned identity/policy, Core enforces attested surface claims

Server decides whether a connection is active and assigns the owner authority plus product surface. Worker knows no human identity or connection directory; it receives only an opaque stable scope and the attested surface. Core retains the final method-surface check.

This is not RBAC: all connections remain owner-equivalent. The check is a capability/interface boundary and limits damage if a Feishu sidecar credential or adapter process is compromised.

### E2 — Product-entry distinction only

All authenticated client transports may invoke every owner Core method. Desktop and Feishu differ only in which commands/UI their trusted client implementation exposes. Remove the Core method-surface deny behavior; Worker can treat every forwarded client request as the same owner authority, retaining only an opaque request/subscription scope where technically required.

This matches a pure product-shape model but means a modified or compromised Feishu client can call desktop-only APIs. Hidden commands/UI are explicitly not a security boundary.

This captured the initial equal-risk requirement but discards useful surface semantics and leaves no clean future channel-policy path. Superseded by E4.

### E3 — Relay performs method authorization

Keep Worker blind and make Relay parse each Core request to enforce method policy. Rejected: it breaks the current opaque-frame, metadata-only Relay boundary, duplicates evolving Core method semantics, and does not map cleanly to Full.

### E4 — Retain surface; Server resolves grants; Core enforces claims (selected)

Server Connection Authority owns the credential-to-surface assignment and the surface-to-grant policy. On each admitted connection it sends Worker/Core only an opaque connection scope plus an immutable, versioned access claim. Core enforces the claim against method capability metadata without learning the human/provider identity or owning the policy directory.

Current policy:

| Surface | Authority/grants | Product entries |
| --- | --- | --- |
| Desktop | Remote Owner Product v1 | Current reachable Remote Desktop product actions |
| Feishu | Remote Owner Product v1, exactly equal to Desktop | Chat/cards expose deliberately implemented interactions, including session deletion |

Future channels may receive a narrower Server-configured grant set. A missing UI/chat entry remains a product decision, while an omitted grant is a real authorization boundary.

Permission-policy changes are stream-bound: the claim carries a policy revision; revocation or a grant reduction fences/reopens affected active streams so an old in-memory claim cannot outlive the Server policy decision.

### Access-contract clean break implied by E4

- Retain a canonical `surface` identifier, but remove permission implications and all readers for retired names such as `desktop-full` and `feishu-session-console`. The only client surface ids are `desktop` and `feishu`.
- Keep credential kind, surface, and grants distinct: credential kind controls operational lifecycle/forced commands, surface selects product/policy identity, and resolved grants control Core method authorization.
- Worker/Core receives no Feishu tenant/open-id or Desktop device identity. Where persistent idempotency/subscription isolation needs a stable key, use a Server-issued opaque connection-scope id with no human identity semantics.
- Remove the hard-coded `CORE_METHOD_METADATA.feishu` classification. Server resolves a bounded/versioned grant claim from its surface policy; Core maps each requested method through the existing method capability metadata and enforces the claim.
- Configure Desktop and Feishu to resolve to exactly the same Remote Owner Product v1 grants in the first release. Add parity tests over the explicit policy catalog so the two surfaces cannot drift accidentally; classify internal/runtime-only methods separately rather than inheriting them.
- Keep the Worker attachment purpose separate and non-client; unifying Owner clients must never allow a Relay Worker credential to invoke Core methods.
- Replace the access/bridge/route contracts with their canonical versions and reject retired surfaces or versions instead of normalizing them.
- Continue exact credential-kind and forced-command checks on Server so a Feishu service credential cannot become a shell, Worker attachment, or unmanaged Desktop export. These checks classify the connection path; Desktop/Feishu still receive equal Remote Owner Product v1 grants.

## Remote Owner Product v1 Permission Baseline (confirmed)

The initial Server policy is seeded from current reachable **Remote Desktop** product behavior, not from every method implemented by Core, every preload function, or dormant renderer code. The policy becomes the durable source of truth; renderer and Feishu entry points consume the effective capabilities and contract tests prevent drift.

### Granted product areas

- Primary navigation: Live, Pending, History, Issues, and Data.
- Session creation from the bounded Workspace root/relative directories, including supported adapter/runtime choices and attachments.
- Session reads and detail projections currently reachable in Desktop: activity/events, tasks, changes/final diff, summary, cross-session messages, pending presentations, context/input capability projections, and outgoing queue where exposed.
- Session mutations currently reachable in Desktop: send, steer, interrupt, runtime update, archive, unarchive, reactivate, delete, pending responses, plan-review actions, handoff, and outgoing removal.
- Issues list/detail and the currently exposed update, resolve-in-new-session, soft-delete, and undelete actions.
- Usage/token/provider data shown by Data.
- Remote node configuration and Hook status reads used by Settings. Remote configuration reset/edit and Hook install/uninstall remain denied.
- Remote bounded asset/catalog/convention reads used by Assets Library. Remote asset/configuration editing remains denied.
- Transport-supporting subscriptions, replay, bounded blobs/files/attachments, and equivalent plumbing only when required by one of the granted product actions; classify these separately from user-facing grants.

### Not granted as current client product areas

- A standalone Team page or direct client Team management. Current top-level navigation has no Team view. `teams.list/get/archive/add-member/shutdown-teammates` and dormant `TeamHub`/remote-team service code do not become grants merely because implementations remain in the repository.
- Server credential administration, connection policy administration, provider credential access, arbitrary host paths, or interactive shell/tunnel access.
- Remote Settings writes, Hook installation/removal, mutable Remote asset management, or fallback to Local operations.
- Internal agent/MCP collaboration methods and Desktop broker/runtime plumbing as user permissions. Where a channel requires internal plumbing, grant it through a separate channel-internal contract rather than Remote Owner Product v1.
- Any Core method with no reachable current Remote Desktop product action until it receives an explicit product decision and policy update.

Team membership/role information already embedded in an authorized session projection may remain visible inside Live/Pending/Session detail. Agent-internal team collaboration also remains available through its trusted runtime path. Neither implies a direct client Team-management grant.

### Policy derivation and drift rules

- Treat `src/renderer/app-view-catalog.ts`, reachable Remote renderer actions, Remote Settings/Assets read-only behavior, and documented Remote behavior as evidence for the initial policy—not as runtime authorization code.
- Store one explicit versioned policy manifest in shared contracts. Server resolves it for both Desktop and Feishu; Core intersects the claim with implemented methods and protocol compatibility; HostHello exposes only the effective capabilities.
- Add a reachability/contract inventory test: every current Remote Desktop business entry must map to a granted capability/method, every explicitly denied area must remain absent, and Desktop/Feishu effective grants must be identical.
- A later Desktop entry addition/removal does not silently change permissions. It must update the policy version, tests, documentation, changelog, and active-stream revision behavior in the same change.
- Correct the stale README statement that says “Remote Teams” as though a Team page still exists; describe session-scoped team metadata/internal collaboration instead.

## Terminology and Clean-Break Contract (confirmed)

Canonical vocabulary:

| Concept | Canonical value/name | Retired input handling |
| --- | --- | --- |
| Local topology | `standalone` / Standalone | accept only the canonical value |
| Relay topology | `relay` / Relay | accept only the canonical value |
| Full topology | `full` / Full | reject the retired topology value `server-core` |
| Core component hosted by Full | Server Core | component/module/process name may remain `server-core`; it is not a topology value |

Clean-break requirements:

- Change the domain constant from `DeploymentTopology.ServerCore = 'server-core'` to `DeploymentTopology.Full = 'full'`.
- Replace the exported `.agentdeck-connection` schema with v3; only v3 with `full|relay` and an explicit opaque `connectionScope` is accepted.
- Replace the persisted Remote profile document with v4; earlier documents are rejected and can be recreated from a current connection bundle.
- Accept only bridge admission v2, route envelope v2, and exact protocol 2.7. Do not negotiate minor skew or synthesize Server grants for older peers.
- Create fresh Feishu metadata directly at schema v3 and Full runtime metadata directly at schema v2; reject any non-current database without mutating it.
- Accept only Feishu config v2 and Server credential document v2 with canonical topology/surface/scope fields.
- Update operator documentation, diagnostics, fixtures, and UI copy to say Full and explain that pre-release artifacts must be recreated.
- Do not mechanically rename `src/hosts/server-core`, the Server Core process, or component-specific symbols merely for terminology consistency. Those names describe a component, not a deployment topology.
- Add negative fixtures proving every retired credential/profile/config/admission/route/database/protocol form fails closed without mutation.

## Decision Ledger

| ID | Question / impact | Owner | Options | Recommendation | Evidence | Status | Answer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-001 | Where should the Feishu gateway run? Affects trust, operations, and networking. | User | Server sidecar / Worker-local / separate host | Server sidecar | Existing outbound-only Feishu service and restricted SSH surfaces in both Relay and Full | Confirmed and generalized | Independent sidecar on the Agent Deck server host in both Relay and Full topologies |
| D-002 | Who issues the Core connection credential? Affects credential isolation and revocation. | User | Local Server authority / reuse Worker credential / manual key | Local Server authority | Existing atomic Relay and Full issuers plus forced-command model | Confirmed and generalized | The selected Server instance issues a dedicated Feishu credential |
| D-003 | Which Feishu setup can be automated? Affects promises and required privileges. | User | Console manual, deploy automated / browser automation | Console manual | App creation, permission grants, publication, and tenant installation are admin-controlled Feishu operations | Confirmed | User completes console setup once; Agent Deck automates deployment onward |
| D-004 | Should first-user discovery replace manual open-id lookup? | User | `/pair` bootstrap / manual binding | `/pair` bootstrap | Current fixed credential reconciliation is secure but high-friction | Confirmed in principle | Add a one-time pairing workflow; exact authority is D-005 |
| D-005 | What proves the first Feishu user is allowed to become owner-equivalent? | User | B1 / B2 / B3 | B1 | Unknown identities are currently rejected; the new bootstrap path crosses that boundary | Confirmed, locus refined | B1: code creates only a pending request; an already authorized Server operator approves it through the installed local CLI |
| D-006 | How should the Linux SQLite runtime be made reproducible? | User | A1 / A2 / A3 | A1 | Current bundle externalizes a native ABI dependency; `node:sqlite` remains active-development | Confirmed | A1: ship a dedicated versioned and digest-pinned Feishu runtime artifact retaining `better-sqlite3` |
| D-007 | What is the first supported product surface? | User | C1 / C2 / C3 | C1 | Current deployment architecture is CLI-based and already has strict command parsing and server-local issuers | Confirmed, locus refined | C1: installed Server CLI is the complete first-release operational interface; no Desktop Settings wizard |
| D-008 | Does Feishu deployment require an already healthy Relay+Worker pair? | Engineering, user may override | Require prerequisite / orchestrate Relay deployment too | Require prerequisite | Keeps lifecycles and rollback boundaries independent | Delegated, reversible | Require an existing healthy Relay; fail closed with a precise prerequisite error |
| D-009 | Which production targets are release blockers? | Engineering, user supplies infrastructure | Ubuntu + EL9 / one distro first | Ubuntu + EL9 | Existing repository contract names both families | Delegated, pending validation | Validate both supported families before declaring production support |
| D-010 | Where is operational connection management executed? Affects authority ownership, reuse, and Worker coupling. | User + Engineering | Unified Server CLI / remote management CLI / topology-specific commands | Unified Server CLI | Relay and Full already issue credentials on their SSH hosts; Worker consumes authenticated access context but owns no issuer | Confirmed after architecture challenge | Put all live connection lifecycle commands on the Server; keep repository deployment commands separate |
| D-011 | Should the first Feishu delivery support both Relay and Full, or only share an abstraction for later Full support? | User | Both topologies now / shared design with Relay first | Both topologies now | Both forced-command surfaces and Feishu SSH topology parsing already exist; the user explicitly wants Server-owned connection management reusable by Full and authorized execution of this recommended plan | Confirmed | First release supports both Relay and Full through one Server control-plane contract and topology adapters |
| D-012 | How should topology names be unified? Affects operator clarity, schemas, and protocol compatibility. | User + Engineering | Canonical `full` with legacy migration / UI-only alias / retain split names | Canonical `full` with legacy migration | `server-core` appeared in connection credential v2, Remote profile v3, admission v1, and Feishu persistence; Server Core is also a legitimate component name | Superseded by D-019 | The vocabulary decision remains; the compatibility-reader portion is superseded by the unreleased clean break |
| D-013 | How do current Desktop/Feishu equality and future channel permissions coexist? | User | E1 / E2 / E3 / E4 | E4 after user refinement | Relay forwards opaque payloads; Worker should not know identity; surface remains useful for future Server policy | Confirmed by user | E4: retain surface and Server-owned policy; Desktop and Feishu have exactly equal Remote Owner Product v1 grants today; future surfaces may differ; Feishu must support session deletion |
| D-014 | What is the topology-independent owner of connection identity/policy? | Engineering | Server Connection Authority / Relay / Worker | Server Connection Authority | Full has no Relay, while both Full and Relay servers already own credential issuance | Delegated, reversible | Use Server Connection Authority; Relay is its implementation in Relay topology |
| D-015 | How should equal current grants and distinct surfaces be represented? | Engineering | Surface + resolved grants / hard-coded surface allowlists / erase surface | Surface + resolved grants | Server needs channel policy/routing; Core needs enforceable claims; Worker needs no identity directory | Delegated, reversible | Canonical neutral Desktop/Feishu surfaces plus a versioned Server-resolved grant claim; current grant sets are identical |
| D-016 | Where are future custom permissions decided and enforced? | Engineering | Server resolves/Core enforces / Relay parses payload / Worker owns policy | Server resolves/Core enforces | Relay payload is opaque and Full must share semantics | Delegated, security-sensitive | Server owns surface policy and policy revision; Core mechanically enforces the immutable claim; policy reductions fence active streams |
| D-017 | What is the initial shared Desktop/Feishu grant baseline? | User | Current reachable Remote Desktop product actions / all Core methods / old Feishu subset | Current reachable Remote Desktop product actions | Team page is removed; Remote Settings and Assets are read-only; current Core/preload code contains methods with no reachable product entry | Confirmed | Versioned Remote Owner Product v1 policy; both surfaces identical; direct Team management and other unexposed/internal methods excluded; session deletion included |
| D-018 | Should dead Team/permissions page code and purposeless compatibility code be cleaned before the new policy/integration? | User | P0 first / defer cleanup / mix into feature work | P0 first | Dormant product surfaces currently distort capability inventory; compatibility deletion needs independent evidence | Confirmed | P0 first, with parallel audits and evidence-gated cleanup; dispatch envelopes live in the P0 child plan |
| D-019 | Must pre-release artifacts and protocol versions remain compatible? | User | Clean break / bounded readers | Clean break | The project has not been formally released; compatibility layers add implementation and test surface without protecting deployed users | Confirmed 2026-08-13 | Keep only current schemas/protocols/topology/surfaces; reject old inputs without mutation and require reprovisioning |
| D-020 | Should the clean-break principle be applied across the whole repository? | User | Parallel repository-wide cleanup / connection-only cleanup | Parallel repository-wide cleanup | P0 retained many candidates solely because its original support-window assumption is now superseded | Confirmed 2026-08-13 | Insert T1.5 after connection-contract stabilization; parallelize disjoint scans/cleanup under explicit dispatch envelopes, then lead-integrate and validate |

## Security and Failure Invariants to Preserve

- Pairing codes are random, short-lived, single-use, stored hashed, rate-limited, and never logged in plaintext after initial display.
- The Server CLI accesses pairing state through a root-restricted management contract; it does not edit the sidecar SQLite database directly.
- A pairing attempt cannot invoke Core business methods before approval. After approval, the Feishu connection receives the same Remote Owner Product v1 grants as Desktop.
- Tenant/app mismatch, sender/operator mismatch, replayed event, expired code, duplicate approval, and concurrent first-claim races fail closed.
- Credential issuance, authorization-file mutation, config writes, and service activation are transactional or compensating; a failed deployment must not leave a broadly authorized key.
- Rollback never restores a revoked or superseded credential accidentally.
- Secret files have explicit owner/mode checks and are excluded from release bundles, diagnostics, and dry-run output.
- Host keys and artifact digests are pinned; no trust-on-first-use during unattended deployment.
- Relay attests an opaque connection scope, canonical surface, resolved grants, and policy revision to Worker/Core. Worker exposes no connection issue/list/revoke/policy authority and never receives the human/provider identity mapping.
- Desktop and Feishu Remote Owner Product v1 grant parity is an explicit first-release invariant. Absence of a Feishu command/card is not itself an authorization control; the shared Server policy is. Security assumes compromise of an approved Feishu Owner credential has the same granted product impact as compromise of a Desktop Owner credential.
- Future restricted surfaces are authorization controls only through their Server-issued grants and Core enforcement, never merely through absent product entry points.
- Health checks distinguish process health, Feishu connectivity, restricted Core connectivity, and full live acceptance.
- Uninstall/revoke operations are explicit and independently reviewable; the first release does not silently delete state.

## Model and Deterministic-Execution Boundary

The shipped Feishu integration adds no LLM decision or model call. Pairing, policy resolution, credential lifecycle, command parsing, idempotency, persistence, migration, health evaluation, and card actions are deterministic state machines with typed/versioned inputs and mechanical tests. Coding agents are an implementation-time workflow only: they may inspect and propose semantic code changes, while the lead deterministically applies/integrates changes, runs validation, and records evidence. No model is asked to reproduce persisted data, assemble exact credentials, decide authorization, or mutate operational state.

## Executable Work Packages

The Agent Deck task records below transfer to the successor session. Dependencies are strict; later work may inspect ahead but must not mutate a dependent boundary before its prerequisite is accepted. Outside the already approved P0 read-only audits, implementation remains lead-owned and serial unless a later exact parallel envelope is explicitly approved.

### T0 — P0 audit and evidence-gated cleanup

- Task id: `77eca0ab-cfbf-4033-beb7-64e75a7f99be`.
- Status/dependencies: first implementation task; no dependency.
- Owner/mechanism: successor lead integrates two pre-approved concurrent read-only native Codex audits from [`feishu-one-click-p0-cleanup-batch.md`](./feishu-one-click-p0-cleanup-batch.md). Audit agents may not write. The lead performs any cleanup after publishing the exact manifest.
- Initial write areas: unreachable `src/renderer/components/TeamHub.tsx`, page-only parts of `TeamDetail/`, `team-data-source.ts`, page-only local/Remote Team CRUD façades, the unused `session.permissions.get` projection chain, their tests, and only compatibility candidates that meet every Cleanup Proof Standard condition. The audit result must replace this candidate list with exact file/symbol dispositions before mutation.
- Protected areas: Agent/MCP team repository/runtime, session-scoped team metadata/tasks/messages/activity presentation, pending permission approval, runtime permission modes and sandboxes, supported migrations/data repair, provider adapters, rollback and security fences.
- Steps: capture clean baseline; dispatch P0-A/P0-B unchanged; verify no source mutation; merge reports and resolve overlap; record the exact delete/trim/move/retain manifest in the child plan; lead applies bounded cleanup; update imports/contracts/docs/tests; record retained uncertain compatibility paths with expiry evidence.
- Validation/done: focused renderer/preload/IPC/Core tests; no dangling production imports or exported dead contract; `pnpm typecheck`, `pnpm test`, `pnpm build`; protected behavior remains covered; child-plan runtime and evidence sections updated.

### T1 — Full terminology migration and Server-owned grant policy

- Task id: `02bd390f-ae14-4c55-bf80-558b1c5be3fe`; blocked by T0.
- Primary write areas: `src/shared/remote-host/connection-credential.ts`, `src/main/remote-host/profile-document.ts`, `src/protocol/bridge-admission.ts`, `src/contracts/access.ts`, `src/contracts/methods.ts`, `src/protocol/relay/`, access-context handling in `src/hosts/relay/` and `src/hosts/server-core/`, and topology/schema fields in `src/hosts/feishu/config.ts` plus `src/gateways/feishu/sqlite-schema.ts`. Component paths/names under `src/hosts/server-core/` are not mechanically renamed.
- Steps: add canonical `standalone|relay|full`; replace credential/profile/admission/route/Feishu persistence readers with strict current-only contracts; inventory current Remote Desktop reachability after T0; classify all Core methods; replace hard-coded Feishu method-surface policy with canonical `surface`, immutable versioned grants, policy revision, and opaque connection scope; keep Server policy ownership and Core enforcement; fence streams on revocation/grant reduction.
- Validation/done: retired schemas/topologies/surfaces/protocol minors fail closed without mutation; mixed topology claims fail; Desktop and Feishu effective Remote Owner Product v1 grants are exactly equal; direct Team/admin/internal methods remain excluded; focused bridge, relay, Core, profile, and Feishu store tests plus full required checks pass.

### T1.5 — Repository-wide pre-release compatibility removal

- Task id: `c0828fa5-616b-4b6d-aedc-50b5819a6a82`; blocked by T1 and blocks T2.
- Goal: apply D-019 to the entire repository, not only the Feishu/connection stack. Inventory every compatibility reader, migration, repair, fallback, alias, optional old DTO field, version-skew branch, deployment evidence reader, and stale compatibility test.
- Parallelization: prepare disjoint dispatch envelopes by repository domain with exact inputs, allowed writes, exclusions, expected output, and validation. Obtain the `parallel-tasks` batch approval before dispatch. Keep shared contracts, indexes, cross-domain integration, conflicts, and final validation lead-owned.
- Removal rule: delete paths whose only purpose is an earlier Agent Deck artifact/version. Retain current upstream-provider shape adapters and active security, corruption-detection, idempotency, secret-purge, path-authority, or crash-recovery fences when their purpose is current rather than historical Agent Deck compatibility.
- Done: no retained compatibility branch lacks an identified current producer/consumer or active safety invariant; each removed domain has focused validation; integrated typecheck/test/build/deployment checks pass; the evidence manifest and any justified retained exceptions are recorded in the plans/review.

#### Parallel cleanup batch A — complete and accepted

Baseline: clean `177a9440`. Initial lead inventory identified concrete historical Agent Deck paths in persistence repair/backfill, Remote product fallbacks, deployment evidence, and generated runtime config stripping. Current upstream-provider shape adapters, protocol mismatch rejection, session-id transfer aliases, rollback generations, crash recovery, idempotency, corruption detection, and security fences are not compatibility merely because they use words such as fallback, old, incompatible, or retired.

Capability inventory: Agent Deck `spawn_session` can enforce Codex adapter, concrete model, reasoning effort, fresh context, `workspace-write`, and `never` approval, and returns results through the direct message watcher. It cannot OS-restrict a worker to an exact subdirectory or directly force network off, so the exact file lists and no-network rule are prompt-enforced and all mutations must be compared with the baseline before acceptance. Native `spawn_agent` was not selected because it cannot enforce a workspace-write sandbox; background shell execution cannot enforce model/context controls. No fallback mechanism is proposed. One exact-envelope retry is permitted only for a transient failure.

Envelope A — persistence telemetry clean break:

- Brief: inspect and remove only pre-fix Agent Deck token-usage repair/backfill behavior. Inputs and allowed writes are `src/main/store/token-usage-legacy-repair.ts`, `src/main/store/__tests__/token-usage-legacy-repair.test.ts`, `src/main/index/bootstrap-infra.ts`, `src/hosts/server-core/token-usage-backfill.ts`, `src/hosts/server-core/token-usage-backfill.test.ts`, and `src/hosts/server-core/repository-host.ts`. Adjacent token-usage files are read-only evidence. Preserve current-schema creation/fingerprint rejection, current token ingestion/rollups/retention, and corruption/transaction safety. Expected output is an exact removed/retained manifest, source edits and test deletion/update, and focused test evidence. Validation: relevant token-usage, bootstrap, repository-host, and DB-schema tests plus typecheck for touched code.
- Mechanism: Agent Deck `spawn_session`; no fallback.
- Controls: requested T1 because persistence semantics can destroy or double-count data; resolved same-family `codex-cli` / `gpt-5.6-sol` / `xhigh`; fresh context; no team; `workspace-write`; `approvalPolicy=never`; local repository only with no network; direct-message return, after which the lead integrates. Exact subpath enforcement and network enforcement are unavailable and must be treated as prompt-enforced/unknown at runtime.

Envelope B — Remote product fallback clean break:

- Brief: remove the obsolete session-console presentation path, unstructured pending-row fallback, and legacy steer fallback while retaining the current rich Remote product path and bounded malformed-input rejection. Inputs and allowed writes are `src/renderer/remote-host/session-summary-presentation.ts`, `src/renderer/remote-host/session-summary-presentation.test.ts`, `src/renderer/remote-host/use-remote-presentation-lists.ts`, `src/renderer/remote-host/use-remote-presentation-lists.test.tsx`, `src/renderer/remote-host/session-detail-source-shell-test-fixture.ts`, `src/renderer/components/pending-rows/RemotePendingFallbackRow.tsx`, `src/renderer/components/pending-rows/RemotePendingRequests.tsx`, `src/renderer/remote-host/RemotePendingRequests.test.tsx`, `src/renderer/components/SessionDetail/RemoteSessionComposer.tsx`, `src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx`, `src/renderer/components/__tests__/HistoryPanel.parity.test.tsx`, `src/renderer/components/__tests__/SessionList.parity.test.tsx`, `src/renderer/remote-host/RemoteDialogs.test.tsx`, `src/renderer/remote-host/use-remote-session-source-detail.test.tsx`, and `src/renderer/remote-host/use-remote-session-source.test.tsx`. Shared contracts, preload/IPC, and `src/shared/file-change-path-authority.ts` remain lead-owned; report required changes instead of editing them. Expected output is the exact removed/retained manifest, current-only renderer changes, and focused Vitest evidence.
- Mechanism: Agent Deck `spawn_session`; no fallback.
- Controls: requested T2 for a multi-file renderer state refactor; resolved `codex-cli` / `gpt-5.6-sol` / `xhigh`; fresh context; no team; `workspace-write`; `approvalPolicy=never`; local repository only with no network; direct-message return. Exact subpath and network enforcement have the same declared limitation as Envelope A.

Envelope C — deployment/runtime artifact clean break:

- Brief: remove legacy non-generation evidence installation/readers and retired `sessionCreationCatalog` stripping while preserving the one current evidence layout, atomic instance-manager install/upgrade/rollback journals, ownership/digest checks, recovery, and strict current config readers. Inputs and allowed writes are `scripts/deployment/artifacts.mjs`, `scripts/deployment/evidence.mjs`, `scripts/deployment/remote-evidence.sh`, `scripts/deployment/deployment.test.mjs`, `deploy/linux/relay/README.snippet.md`, `deploy/linux/relay/preflight.sh`, `deploy/linux/relay/static-check.sh`, `deploy/linux/full/README.snippet.md`, `deploy/linux/full/preflight.sh`, `deploy/linux/full/static-check.sh`, `src/hosts/instance-manager/evidence.ts`, `src/hosts/instance-manager/change.ts`, `src/hosts/instance-manager/lifecycle.ts`, `src/hosts/instance-manager/plans.ts`, `src/hosts/instance-manager/recovery.ts`, adjacent `src/hosts/instance-manager/*.test.ts`, `src/hosts/local-worker/headless-config.ts`, `src/hosts/local-worker/headless-config.test.ts`, `src/hosts/server-core/config.ts`, and `src/hosts/server-core/config.test.ts`. Expected output is the exact evidence-path/config-field manifest, current-only code/docs, focused instance/deployment tests, and static-check evidence.
- Mechanism: Agent Deck `spawn_session`; no fallback.
- Controls: requested T1 because deployment ownership, rollback, and security evidence are affected; resolved `codex-cli` / `gpt-5.6-sol` / `xhigh`; fresh context; no team; `workspace-write`; `approvalPolicy=never`; local repository only with no network; direct-message return. Exact subpath and network enforcement have the same declared limitation as Envelope A.

Lead-owned concurrent scope: audit provider adapters and public facades under `src/main/adapters/`, `src/main/session/{summarizer,manager}/`, `src/contracts/permission-preview.ts`, `src/contracts/current-api-classification.ts`, and `resources/bin/node-repl-browser-process-compat.cjs`; retain variants proven to be produced by the current upstream provider/runtime, and apply only Agent Deck-history removals. The lead also owns every shared contract/type/IPC change, cross-envelope conflict, full repository scan, integration, and validation.

Approval: the user explicitly replied `继续` to the complete batch-A approval presentation on 2026-08-13. No envelope, mechanism, control, fallback, or validation scope changed after presentation.

Dispatch runtime, 2026-08-13:

- Envelope A: session `019ffe90-ba54-7132-8318-583ab32dec1d`, reply anchor `ab99480a-95cf-4d14-89d9-21be4e7b3e7d`. Returned metadata confirms `codex-cli`, exact shared cwd, no team, and display name `T1.5 persistence cleanup`. The interface accepted the requested model/thinking/fresh/sandbox/approval controls but did not echo them, so their observed runtime values remain unknown rather than inferred. Completed without substitution: exactly six allowed paths changed, deleting the two historical token repair/backfill implementations and tests plus their startup wiring (611 deletions). The worker reported 9 focused files/64 tests, typecheck, and diff checks passing; lead baseline comparison independently confirmed the exact six-path delta and no remaining production references. The worker was told to stop after acceptance.
- Envelope B: session `019ffe90-bc23-76d3-b895-53526d1e057c`, reply anchor `36942093-1ed8-49fd-a2c5-38d77636877b`. Returned metadata confirms `codex-cli`, exact shared cwd, no team, and display name `T1.5 remote fallback cleanup`; non-echoed controls remain observed-unknown. Completed without substitution: the obsolete Remote session-list/status converter, raw pending fallback row, permissive unstructured permission rendering, and implicit composer steer inference were removed across exactly the 15 allowed renderer paths. Rich presentation pages, explicit input modes, structured permission/question/plan/diff displays, pagination fencing, revision reload, deletion/history actions, and Desktop/Remote parity remain. The worker reported 10 focused files/90 tests, typecheck, and diff checks passing; lead baseline comparison confirmed the exact write set. The worker was told to stop after acceptance.
- Envelope C: session `019ffe90-bb40-7243-953f-38b833ceac4b`, reply anchor `d84017c1-d3a1-4b1a-979b-9a82661db931`. Returned metadata confirms `codex-cli`, exact shared cwd, no team, and display name `T1.5 deployment cleanup`; non-echoed controls remain observed-unknown. Completed without substitution: four allowed config files stopped stripping the retired `sessionCreationCatalog` field, and seven allowed deployment/evidence files renamed current non-generation evidence from misleading `legacy` terminology to `runtime` without changing stable paths, contents, ownership, modes, digest binding, systemd consumers, journals, rollback, or recovery. Direct deletion of the runtime evidence layer was rejected because current Full restart and Relay security consumers require it; this is classified as a retained current safety invariant, not compatibility. The worker reported focused 46-test and 14-test runs, deployment checks, Full/Relay static checks, and diff checks passing; lead baseline comparison confirmed the exact 11-path delta and no residual active evidence-related legacy naming. The worker was told to stop after acceptance.
- All three dispatches succeeded without fallback or substitution. Every direct-message report was consumed, its paths were compared against clean `177a9440`, and all workers were explicitly stopped before lead integration.

Lead-owned integration removed the dead current-API classification facade; replaced it with direct Core method-metadata coverage; removed the retired normalized Codex collaboration shape while retaining current upstream `collabAgentToolCall` and `subAgentActivity` inputs; made file-change path authority fail closed; required presentation provenance; removed duplicated permission-preview fields; required exact structured question/permission/plan/diff/exit-plan displays; removed the obsolete Desktop `session.console.list` IPC/preload/service chain; and made Remote Live/History depend solely on `sessions.presentation.read`. Current provider adapters, Browser process compatibility, Grok live telemetry reconciliation, protocol mismatch rejection, deployment generation/runtime evidence, rollback/recovery journals, corruption checks, idempotency, and secret/path-authority fences were retained because their current producers or safety consumers were proven.

T1.5 acceptance is commit `bdc7bdb3` (`refactor: remove pre-release compatibility layers`): 97 paths, 1,070 insertions, 2,023 deletions. Validation passed with 952 test files / 6,056 tests (3 expected skips), focused IM and Remote regressions, `pnpm typecheck`, `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, Full and Relay static checks, `git diff --check`, the 500-line gate, and the review-expiry inventory. The only initial validation failures were stale current-schema test fixtures and a 524-line shared test fixture; the fixtures were corrected and the pending constructor was split, leaving the largest touched fixture at 499 lines.

### T2 — Unified Server Connection Authority and installed CLI

- Task id: `7a0b8e95-2f89-4aa4-9bc5-dbc53a750ae5`; blocked by T1.5.
- Primary write areas: `src/hosts/linux-runtime/connection-credential-issuer.ts`, Relay/Full `connection-issuer.ts`, forced-command bindings and control services under `src/hosts/relay/` and `src/hosts/server-core/`, the shared instance/control plane under `src/hosts/instance-manager/`, CLI entrypoints/build manifests, and `deploy/linux/{relay,full,feishu}/` templates/static checks.
- Steps: define topology-neutral Server management contracts and adapters; implement `feishu connect|upgrade|status|verify|pair list|pair approve|pair reject|credential rotate|disconnect` (exact naming may follow existing CLI grammar); acquire root-restricted local management access; issue dedicated Feishu credentials with exact forced commands; keep connection identity/policy directory off Worker; accept secrets only through protected files/stdin or interactive input; make check/dry-run/mutation/verify atomic, idempotent, redacted, and rollback-aware.
- Validation/done: Relay and Full parity contract tests; no shell/Worker/Desktop credential escalation; failure injection proves no partially broad authorized key/config/service state; revoke/rotate fences active access; status distinguishes process/Feishu/Core/live acceptance; CLI help/errors follow `UI_COPY_LANGUAGE.md` Simplified Chinese mode; focused tests and Linux/deployment static checks pass.

### T3 — Reproducible Feishu runtime, pairing, and product actions

- Task id: `28ac9476-104b-4a10-954f-373704227060`; blocked by T2.
- Primary write areas: `src/hosts/feishu/`, `src/gateways/feishu/`, Feishu packaging/build inputs, `deploy/linux/feishu/`, Relay/Full release manifests and service integration, plus product command/card tests.
- Steps: ship the dedicated digest-pinned Node runtime artifact retaining `better-sqlite3`; make service ownership/permissions and artifact provenance reproducible on Ubuntu and EL9; add random hashed short-lived single-use pairing codes, rate limits, pending candidate state, local Server CLI approval, and race-safe first claim; preserve tenant/app/sender/operator checks; expose current Remote Owner Product v1 product actions; add session deletion with exact target preview, explicit confirmation, stable idempotency, and authoritative result; preserve replay/delivery recovery.
- Validation/done: cold start/restart/reconnect, duplicate/replayed/expired pair requests, concurrent approvals, unauthorized users, app/tenant mismatch, credential revocation, secret rollback, delivery retries, and destructive confirmation all pass; no secret appears in argv/logs/bundles/diagnostics; both topology services use the same product contract.

### T4 — Integrated validation, review, documentation, and archive

- Task id: `eb498456-2266-42d3-a0ed-d266140b53e5`; blocked by T3.
- Write areas: tests/fixtures adjacent to changed code; `README.md`; `deploy/linux/{relay,full,feishu}/` runbooks/examples; applicable scripts/manifests; final `ref/changelogs/`, `ref/reviews/`, and `ref/plans/` records plus indexes.
- Steps: run review-expiry and file-size checks; perform security, lifecycle, architecture, clean-break, packaging, and rollback review; fix in-scope findings; run all local validation; validate clean Ubuntu and EL9 flows and a real Feishu round trip when pre-existing safe infrastructure/secrets are available; otherwise finish all reproducible local/static work and record the exact external acceptance blocker without inventing success; archive the final plan and clean/retain `.ref` material according to `CLAUDE.md`.
- Required commands: focused `vitest` while iterating; `pnpm typecheck`; `pnpm test`; `pnpm build`; `pnpm build:linux-headless`; `pnpm check:linux-headless`; `pnpm check:deployment`; applicable `deploy/linux/*/static-check.sh`; `bash scripts/file-level-review-expiry.sh`; file-size inventory. Main/preload changes require the documented development restart after validation.
- Done: branch is clean with cohesive commits, all available required checks pass, final records/indexes are correct, operational runbooks cover install/check/dry-run/deploy/upgrade/verify/rollback/revoke, residual risks and unavailable external acceptance are explicit, and the result is ready for user acceptance.

## Required Review and Acceptance

- Security review of pairing authority, credential scope, secret handling, redaction, replay/race behavior, revocation, and rollback.
- Lifecycle review of install, upgrade, failed deploy, partial credential issuance, service restart, host reboot, and redeploy idempotence.
- Packaging review for supported architecture/libc/Node combinations and artifact provenance.
- Automated repository checks: typecheck, focused tests, full test suite as proportional, Linux static checks, build, and file-size limits.
- Real-host acceptance on clean Ubuntu and EL9-family systems.
- Real Feishu acceptance: receive message, create/select session, send prompt, render/update card, reject unauthorized user, revoke credential, and prove reconnect behavior.

## Checkpoint C — Final Plan Review

- No material user-owned decision remains unresolved. A1, B1, C1, Server-owned connection lifecycle, canonical `full`, retained `surface`, Server-resolved/Core-enforced policy, Remote Owner Product v1 parity, Feishu session deletion, P0-first cleanup, and Relay+Full first-release scope are confirmed.
- P0 prevents dormant Team/permissions code from inflating grants. D-019 supersedes P0's original release-compatibility assumption while retaining its evidence discipline for current security/provider/recovery invariants.
- Dependency order prevents schema/policy implementation from racing cleanup; T1.5 completes the repository-wide clean break before CLI/runtime code targets the stabilized contracts.
- Worker never gains a connection directory or human/provider identity. Server policy decisions are enforceable because Core receives immutable claims and rejects methods mechanically.
- Rollback of current artifacts, strict schema rejection, secret handling, pairing race/replay behavior, forced commands, revocation, packaging provenance, and external acceptance have explicit tests or stop conditions.
- The only expected environmental uncertainty is access to clean Ubuntu/EL9 hosts and a real tenant-installed Feishu app. Missing infrastructure blocks only those final live acceptance checks, not safe local implementation and static validation.
- Final-plan approval was granted by the user on `2026-08-13` with instruction to hand off into an isolated worktree/branch, proceed continuously, and leave the finished result for later acceptance.

## Final Execution State and Handoff

- T0 through T4 implementation and all available local/static plus authorized Relay live acceptance are complete in the isolated `codex/feishu-one-click-server` branch. Feature implementation is commit `09c7676bd6095411177dd49664c678d77b6ae538`; commits `23f83f8d` and `4fd97004` separate Relay's mutable authority and fix private-directory verification. Earlier bounded upload, low-disk installation, reproducibility, connection-control, and clean-break work remains in separate cohesive commits.
- The installed root-only CLI owns `connections issue|list|verify|revoke|rotate` and `feishu check|dry-run|connect|status|verify|upgrade|pair create|pair list|pair approve|pair reject|credential rotate|disconnect` for both Relay and Full. It provisions a dedicated credential and service-owned protected files transactionally, exposes only a mode-0600 local management socket, rotates with an explicit predecessor fence and retry-safe restart, and compensates failed service/config/authority transitions.
- Pairing uses 192-bit hash-only ten-minute single-use codes plus local Server approval. Deletion is p2p-only with an exact five-minute snapshot confirmation, stable idempotency, and Core compare-and-set. Desktop and Feishu receive the identical explicit Remote Owner Product v1 grant set, while `surface` remains available for routing and future policy. Restricted-Core verification checks exact grants/internal methods and requires a live `access_denied` response for forbidden `system.health`.
- The digest-pinned runtime retains `better-sqlite3` 11.10.0 on Node 22.22.3 ABI 127, installs immutable root-owned amd64/arm64 releases, and supports verified active/desired upgrade rollback. Archive validation rejects traversal, duplicates, build source/tests, and secret-like paths.
- Focused behavior/security coverage passed, including 8 files / 46 authority/deployment tests. Three oversized T1.5 test suites were partitioned by topic with 33 focused tests passing; after integrating the latest `main`, the complete suite passed 966 files / 6,112 tests, with 2 files / 3 tests skipped by existing opt-in guards. `pnpm typecheck`, `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, Full/Relay/Feishu/Manager static checks, review-expiry, the 499-line maximum changed-source inventory, and `git diff --check` all passed.
- Four independent runtime build processes produced byte-identical artifacts: amd64 `f1a5392b0635a47b08cb9e1b066f38302ad9c8192e170029182338e813777d52` (45,471,494 bytes) and arm64 `59bc3544f016c2b920e1b956c84e731eedec98e8778b3a42f97df27cfd72d2af` (45,287,836 bytes). Both artifacts passed inner checksum, pinned Node/ABI, and real bundled SQLite checks in Ubuntu 24.04 and Rocky Linux 9 containers.
- An authorized ARM64 Ubuntu Relay host completed the one-way clean break to schema-v2 release `git-4fd970044463`, generation 15, followed by a normal same-schema upgrade to `git-f6d977adcbd0`, generation 16. Official rollback produced generation 17 at 4fd and a second rollback produced the final generation 18 at f6d. Every transition passed official verification; final current/previous records are f6d/4fd, installed config/unit and retained backups match their recorded digests, the journal is clear, and the exact digest-pinned container is healthy. No compatibility reader was added and no local process was terminated.
- The installed root-only CLI passed authority verification and disposable connection `issue`/idempotent reissue/`rotate`/idempotent rerotate/`revoke`/idempotent rerevoke. A schema-v2 live test additionally proved `issued → active → revoked` projection through the directory bind without changing the Relay container start time. Across both rollbacks the authority remained one active Relay Worker plus five owner/client rows: the original Desktop credential is active and all four disposable credentials are revoked, with no test authorization or private output left behind. `feishu check` reports the runtime ready/installed and `feishu status` proves the unconfigured sidecar remains safely inactive.
- The Relay Worker was offline during acceptance, so Relay service independence is proven but no Core session flow is claimed. No authorized Full or EL9-family systemd host and no tenant-installed Feishu credentials were available; Full live deployment plus real Feishu receive/send/card/pair/delete/reconnect/revocation/load acceptance remain explicit external items.
- The repository-required main/preload development restart was skipped at the user's explicit direction not to terminate existing processes. No installed or currently running Agent Deck instance is counted as validation for this branch.
- Final records: `CHANGELOG_612_feishu-server-one-click.md`, `REVIEW_248_feishu-server-one-click-acceptance.md`, `REVIEW_249_feishu-relay-live-acceptance.md`, and `PLAN_38_feishu-one-click-server.md`.
