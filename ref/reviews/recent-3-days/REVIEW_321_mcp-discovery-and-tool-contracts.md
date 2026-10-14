---
review_id: 321
reviewed_at: 2026-10-13
baseline_commit: cfa43ce9dd64450859f48346d9ff069b2a3006b3
coverage: contract-and-authorization-entrypoints
expired: true
---

# MCP discovery and tool contracts

## Scope and method

User-requested inspection of unrelated-session discovery and all Agent Deck MCP tools. This is a lead-only contract audit, not a paired simple-review or deep-review run. It covers published descriptions, schemas, authentication, target-scope checks, related repository behavior, and selected regression tests. It does not certify every provider lifecycle, race, sandbox, or browser engine implementation. `expired: true` deliberately prevents this focused audit from exempting whole modules from a later full review.

The live Local tool inventory contains 20 tools. Server Core registers those 20 names, 14 legacy Browser bridge operations, and up to 5 optional Feishu tools: 39 distinct names at maximum. Server Core-only contracts were inspected in source, not through a live remote host. No production handler was invoked against live sessions.

The review-expiry script was attempted. Its mapping stream contained 407 MCP-related rows, including 22 without a baseline, but a separate direct execution exited 1. Earlier review coverage was not used to exempt any contract from this inspection. The helper failure was left outside this delivery scope.

```review-scope
src/main/agent-deck-mcp/types.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/agent-deck-mcp/tools/schemas/tasks.ts
src/main/agent-deck-mcp/tools/handlers/list.ts
src/main/agent-deck-mcp/tools/handlers/get.ts
src/main/agent-deck-mcp/tools/handlers/list-session-events.ts
src/main/agent-deck-mcp/tools/handlers/send.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
src/main/agent-deck-mcp/tools/handlers/ask-user.ts
src/main/agent-deck-mcp/tools/handlers/request-plan-review.ts
src/main/agent-deck-mcp/tools/handlers/request-diff-review.ts
src/main/agent-deck-mcp/tools/handlers/task-helpers.ts
src/main/agent-deck-mcp/tools/handlers/task-create.ts
src/main/agent-deck-mcp/tools/handlers/task-list.ts
src/main/agent-deck-mcp/tools/handlers/task-get.ts
src/main/agent-deck-mcp/tools/handlers/task-update.ts
src/main/agent-deck-mcp/tools/handlers/task-delete.ts
src/main/agent-deck-mcp/tools/handlers/report-issue.ts
src/main/agent-deck-mcp/tools/handlers/append-issue-context.ts
src/main/agent-deck-mcp/tools/handlers/update-issue-status.ts
src/main/store/session-repo/history.ts
src/hosts/server-core/mcp-server.ts
src/hosts/server-core/mcp-tool-host.ts
src/hosts/server-core/mcp-session-tools.ts
src/hosts/server-core/mcp-session-collaboration.ts
src/hosts/server-core/mcp-session-visibility.ts
src/hosts/server-core/mcp-task-tools.ts
src/hosts/server-core/mcp-issue-tools.ts
src/hosts/server-core/mcp-spawn-tools.ts
src/hosts/server-core/mcp-handoff-tools.ts
src/hosts/server-core/mcp-worktree-tools.ts
src/hosts/server-core/mcp-presentation-tools.ts
src/hosts/server-core/mcp-presentation.ts
src/hosts/server-core/mcp-feishu-preferences.ts
src/hosts/server-core/mcp-feishu-work-sessions.ts
src/hosts/server-core/mcp-browser-tools.ts
src/hosts/server-core/feishu-work-session-directory.ts
src/hosts/server-core/feishu-assistant-authority.ts
src/hosts/server-core/feishu-work-management.ts
```

## Design finding: discovery and control have different scopes

Local `list_sessions` defaults to active caller-related sessions. Explicit `spawnedByFilter` skips the relation predicate, and Local global-token external readers also bypass that predicate. `get_session` returns metadata by known ID without checking the caller/target relationship. `send_message` explicitly supports unrelated, teamless DMs. `shutdown_session` rejects self and missing targets but has no target ownership, spawn, or team check. Server Core preserves the explicit list exception, broad get, teamless messages, and broad shutdown for authenticated live callers.

Evidence: `tools/handlers/list.ts:113`, `get.ts:21`, `send.ts:90`, and `shutdown.ts:33` under `src/main/agent-deck-mcp/`; Server Core equivalents are `src/hosts/server-core/mcp-session-collaboration.ts:106`, `:123`, `:155`, and `:186`.

```ts
if (!args.spawnedByFilter && ctx.caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
  return filterRelatedForCaller(sessions, ctx.caller.callerSessionId);
}
return sessionManager.enrichWithTeamsBatch(sessions);
```

Normal consequence: independent work sessions cannot discover one another through the normal list call, although known IDs enable metadata reads and communication. Broadening discovery also makes already-permitted destructive targets easier to discover. An isolated Core probe with two unrelated roots confirmed that `shutdown('caller', { sessionId: 'unrelated-root' })` invokes the injected close dependency. It did not close a real session.

This is a product-policy inconsistency, not proof of a cross-user authorization bypass. The published contract does not promise related-only shutdown. Choose discovery and destructive-control policies explicitly rather than relying on undiscoverable IDs. Decision impact: major.

## Verified defects

### F1 — MEDIUM: Core handoff loses teamless descendant visibility

Location: `src/hosts/server-core/mcp-session-visibility.ts:56` and `:87`.

```ts
const callers = forwardLineage(callerSessionId, ports.successor);
const targets = forwardLineage(targetSessionId, ports.successor);
```

State sequence: source creates a child without a team; source hands off to successor; the child keeps historical `spawnedBy = source`; successor has no forward successor. The visibility helper examines the successor's forward chain, never its predecessor ownership. Neither spawn comparison relates successor to the old child. Core handoff transfer preserves historical spawn provenance and records aliases rather than rewriting this edge.

Verification: executed the actual transpiled visibility function with synthetic session and alias ports. `source -> child` returned true; `successor -> child` and `child -> successor` both returned false. The default list consequently omits that child, and `list_session_events` rejects it. Shared active team membership masks the problem. Local already resolves predecessor ownership lineages.

Direction: share the committed ownership-lineage relation semantics across hosts, with bounded traversal and source-reactivation behavior. Add a no-team handoff regression for list and event reads. Decision impact: routine compatibility repair.

### F2 — MEDIUM: Core handoff breaks late teamless messages and reply anchors

Locations: `src/hosts/server-core/mcp-session-collaboration.ts:155` and `:273`; compare Local `src/main/agent-deck-mcp/tools/handlers/send.ts:43` and `:164`.

```ts
const samePair =
  (original.fromSessionId === callerSessionId && original.toSessionId === targetSessionId) ||
  (original.fromSessionId === targetSessionId && original.toSessionId === callerSessionId);
if (!samePair) throw new Error('Teamless reply belongs to another session pair');
```

State sequence: a source sends a delivered message to a child, then hands off and closes. The child replies using the original wire sender and anchor. Core resolves only direct session/CLI IDs, so targeting the old source fails as unavailable. Even if the child learns the successor ID, the original delivered anchor still contains the source ID and the raw pair comparison rejects it. Transfer retargets pending messages only; rewriting historical delivered anchors is intentionally unnecessary in Local because Local canonicalizes both endpoints.

Verification: actual transpiled Core collaboration methods with a synthetic dispatcher returned `Target session is unavailable` for the old source, and `Teamless reply belongs to another session pair` for the new successor with the old anchor.

Direction: resolve committed target successors before availability/self checks and canonicalize historical DM endpoints before comparing pairs, preserving team boundaries. Decision impact: routine compatibility repair.

### F3 — MEDIUM: history pagination can end after 500 matching rows

Locations: `src/main/store/session-repo/history.ts:20`, Local `src/main/agent-deck-mcp/tools/handlers/list.ts:54`, and Core `src/hosts/server-core/mcp-session-collaboration.ts:206`.

```ts
const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
```

Core requests history once with limit 10,001 and offset 0, then pages the returned array. The shared history repository caps that request at 500. Local `statusFilter: 'all'` repeatedly asks for a growing prefix, so it also cannot include history beyond that repository cap. Local `statusFilter: 'closed'` correctly scans with increasing repository offsets.

Verification: executed the actual Local/Core listing algorithms and actual repository limit code against 650 synthetic closed rows using an explicit parent recovery filter to remove relation ambiguity. Core offset 400 / limit 100 returned 100 and `hasMore: false`; offset 500 returned 0. Local `all` at offset 500 returned 0; Local `closed` returned 100 and `hasMore: true`. Core production wires the shared repository through `repository-host.ts:67` and `runtime-composition.ts:208`.

Direction: query true bounded pages rather than a capped prefix. Expose continuation when an internal scan budget is reached, instead of reporting end-of-list. Test mixed lifecycle ordering and more than 500 historical matches. Decision impact: routine correctness repair.

## Description and schema drift

LOW, verified by direct source comparison:

1. Core `list_sessions` says only “related” in its main description although `spawnedByFilter` bypasses relation checks. The shared parameter description does disclose the exception. Core `get_session` does not state its broad metadata scope. Local `statusFilter` wording also omits the explicit parent-filter exception.
2. Core `spawn_session` publishes the shared output schema whose `cwd` description says “absolute”, while Core returns a Workspace-relative directory. See `src/main/agent-deck-mcp/tools/schemas/spawn.ts:183` and `src/hosts/server-core/mcp-session-spawn.ts:336`. The runtime value conforms to Core's intended path model; the documentation is wrong for that host.
3. `present_diff.timeoutMs` says omission uses the app permission timeout. Local applies that setting and caps an explicit timeout by it; Core uses `args.timeoutMs ?? null`, meaning indefinite wait when omitted. See `tools/schemas/session.ts:172`, `tools/handlers/request-diff-review.ts:23`, and `src/hosts/server-core/mcp-presentation.ts:125`.
4. Core's abbreviated handoff/worktree descriptions omit lifecycle instructions present in Local, including immediate source termination after a successful handoff and the accepted-but-not-yet-switched worktree state. Some rules remain in bundled runtime instructions and result schemas, but the tool description alone is incomplete.

Direction: share common contract paragraphs and explicitly override host path, timeout, availability, and authentication differences. Keep description validation semantic rather than checking for matching prose alone.

## Complete Local tool matrix

“External” means the Local global-token read-only identity. Server Core requires a real authenticated, unarchived, non-closed session, with adapter identity validation. Native provider permission policies remain a separate layer.

| Tool | Enforced scope / behavior | Contract assessment |
|---|---|---|
| `list_sessions` | Related by default; explicit parent recovery and Local external reads are broad; metadata only | Discovery design and pagination need attention; Core relation defect F1 |
| `get_session` | Known ID, broad metadata; Local external allowed | Scope should be explicit in both hosts |
| `list_session_events` | Self/ownership/spawn/shared active team; external denied | Boundary is appropriate; Core handoff relation defect F1 |
| `send_message` | Any open target except self; unrelated DM allowed; shared-team and reply checks | Local description explicit; Core handoff messaging defect F2 |
| `shutdown_session` | Any existing target except self; closes/aborts; external denied | Destructive authority needs a product decision; no relation guard |
| `spawn_session` | Authenticated caller derives parent; adapter/runtime/fork and spawn guards | Local detailed; Core output path description differs; provider effects not exercised live |
| `hand_off_session` | Current source only; transfers owned resources to fresh successor | Current-source entrypoint checked; Core collaboration consumers do not fully preserve handoff semantics |
| `enter_worktree` | Caller-owned transition, exact observed tool invocation, detached checkout | Core description omits important transition semantics; targeted worktree tests passed |
| `exit_worktree` | Caller-owned lease; identity/reference/dirty and durable-HEAD checks | Keep explicit discard authorization distinct from metadata discovery; Core description abbreviated |
| `ask_user` | Current caller; bounded pending questions; cancellation distinct from answers | Shared description/schema; Local/Core targeted tests passed |
| `present_plan` | Current caller-owned blocking user gate | Core and Local ownership entrypoints checked; no unrelated target argument |
| `present_diff` | Current caller-owned approval/revision gate | Timeout default contract differs across hosts |
| `task_create` | Personal owner from caller; team creation requires active membership | Scope and description agree |
| `task_list` | Own personal tasks plus active-team tasks | External normally receives an empty scope; `total` is current-page size |
| `task_get` | Personal owner or active task-team member; external denied | Read scope matches writes |
| `task_update` | Same write boundary; new team membership checked; only owner can make team task personal | Scope and patch semantics agree |
| `task_delete` | Same write boundary; optional cascade only through writable downstream tasks | Scope and destructive/non-idempotent Local description agree |
| `report_issue` | Caller becomes issue source; external denied; Core confines directory to Workspace | No agent issue-list/get exists by design; retain returned ID |
| `append_issue_context` | Current logical owner of source lineage only; deleted/resolved restrictions | Handoff ownership rule agrees with implementation |
| `update_issue_status` | Current logical owner of source or resolution lineage; deleted denied | Optional note is non-idempotent; Local note/status writes are separate, and retry hint warns of partial writes |

Supporting implementations: `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts`, `src/hosts/server-core/mcp-task-tools.ts`, the three issue handlers, and `src/hosts/server-core/mcp-issue-tools.ts`. No additional concrete ownership defect was verified in these task/issue entrypoints during this pass.

## Server Core-only tools

| Tool | Scope and contract |
|---|---|
| `get_feishu_preferences` | Any valid Core session caller; read-only saved owner preferences and revision; registration conditional on host capability |
| `update_feishu_preferences` | Current registered Feishu assistant; revision and stable request-ID checks; changes future defaults |
| `list_work_sessions` | Registered assistant; open work across Core Workspace, excludes assistant/internal/closed/archived rows; explicit raw-row continuation |
| `create_work_session` | Current registered assistant; Workspace directory, preferences revision, spawn guards and request-ID deduplication; independent work |
| `rename_work_session` | Current registered assistant; open work target, expected-title check and request-ID deduplication |

The existing `list_work_sessions` already demonstrates a separate directory that discovers independent work. Its assistant-only eligibility should not silently become the authority model for ordinary coding sessions. Feishu write-tool user-intent requirements live in their descriptions/native permission layer; the handlers enforce identity, revisions, and target constraints, not a new universal confirmation dialog.

The 14 registered legacy Browser tools are:

| Operations | Shared boundary and behavior |
|---|---|
| `browser_open`, `browser_navigate`, `browser_close` | Authenticated caller is bound to a desktop browser owner; tab lifecycle/navigation |
| `browser_tabs`, `browser_wait` | Caller-owned tab inventory and bounded readiness waits |
| `browser_snapshot`, `browser_screenshot` | Caller-owned inspection and inline imagery |
| `browser_click`, `browser_type`, `browser_press`, `browser_scroll` | Caller-owned references and interaction; can change website state |
| `browser_read_console`, `browser_read_network` | Bounded diagnostic reads from caller-owned tabs |
| `browser_evaluate` | Caller-owned bounded expression evaluation; not marked read-only |

Registration and dispatch are in `src/hosts/server-core/mcp-browser-tools.ts`, `desktop-broker.ts`, and `src/main/remote-host/desktop-browser-broker.ts`. Tabs have session ownership; persistent website cookies/storage are shared, as the descriptions disclose. No Browser operation was invoked. Local exposes none of these tools, and all three bundled adapter instructions direct agents to the session-scoped Browser CLI and prohibit legacy `browser_*` usage. Core has a CLI runtime as well. Decide whether the legacy registrations should be hidden from normal agent profiles or remain an explicitly documented compatibility surface.

## Adjustment options

| Option | Proposed behavior | Trade-off |
|---|---|---|
| A: explicit broad scope | Add `scope: related | workspace`; retain `related` default for compatibility | Small migration; agents still need an explicit discovery call |
| B: metadata directory by default (recommended) | Default to all open work metadata within the current owner/host or Core Workspace; keep `related` as a filter | Directly enables independent-session collaboration; needs bounded paging and noise filters |
| C: separate discovery tool | Keep current list semantics; introduce `discover_sessions` or a generalized work directory | Clear separation, but duplicates list/get vocabulary and increases tool-choice overhead |

Recommended behavior under B:

1. Metadata discovery/get cover the same allowed host/Workspace domain. Include active and dormant work by default, exclude internal/archived rows, and make history explicit. Workspace is the authority domain, not an equality test on `cwd`; worktrees and sibling repositories can cooperate.
2. Make relationship a filter/result attribute. Keep `spawnedByFilter` as an ordinary filter; recovery should not implicitly switch the authorization model. Add useful title/directory/adapter/team filters with bounded pages and a reliable continuation token.
3. Keep history/events behind ownership, spawn, active-team, or separately granted read authority. Metadata discovery does not imply transcript access.
4. Keep cross-session DM support, with clear caller/target identity and delivery status. User authorization to send remains separate from technical discoverability.
5. Give destructive lifecycle operations their own authority predicate: for example, caller-created descendants and their committed successors, plus an explicit owner grant for unrelated work. Shared membership alone should not automatically let a teammate close its lead.
6. Return authoritative allowed-action metadata only if backed by the same handlers, and revalidate it when the action executes. A cached capability list must not become the authorization check.
7. Unify the underlying relation/ownership and query logic across hosts. Keep host-specific paths, runtime ceilings, and caller types explicit.

Implement F1–F3 independently of the chosen discovery policy. Complete the destructive-authority decision before enabling broad discovery by default. Changes to descriptions and paired runtime prompt assets should be reviewed as a single coherent contract change.

## Validation / evidence

- Existing targeted suites: 24 files, 343 tests passed through the repository's Electron-as-Node test runner. Covered Local tool contracts, tasks/issues, spoofing/HTTP identity, runtime controls, worktree contract, and Core registration, collaboration, spawn, handoff, presentations, Feishu, and desktop broker.
- Isolated probes loaded production TypeScript through the installed TypeScript transpiler and injected synthetic repositories/dispatchers. F1/F2 exercised actual visibility/collaboration methods; F3 exercised actual listing and history-limit code. No live database, provider, messaging, or shutdown dependency was used.
- The SQLite native-binding SHA-256 was identical before and after testing.
- The baseline working tree was clean. Only audit/plan records and their bucket indexes were added or updated.
- All review/plan buckets were scanned for numbering and dates. No existing record required moving on the audit date; root routing policies remain unchanged.

## Fixes landed

None. The user requested design options and inspection. Production code, MCP descriptions, bundled prompts, live sessions, and the installed application remain unchanged.

## Residual risk and follow-ups

F1–F3 remain unfixed. Shared-team tests mask F1/F2; small mocked repositories mask F3. Targeted passing tests therefore do not establish the correctness of these missing cases. This audit did not inspect raw user transcripts or attempt adversarial operations on real sessions.

The discovery default, history-access policy, destructive authority, and legacy Browser tool exposure remain user-owned product decisions. Broader lifecycle/security review is still required for an implementation that changes those policies.

## Subsequent implementation

On 2026-10-14 the user-approved implementation repaired F1–F3 and applied the selected discovery/control policy. See `ref/reviews/recent-3-days/REVIEW_322_mcp-handoff-and-control.md` and `ref/changelogs/recent-3-days/CHANGELOG_676_mcp-discovery-and-diff-focus.md`. The audit above remains the historical pre-change assessment.
