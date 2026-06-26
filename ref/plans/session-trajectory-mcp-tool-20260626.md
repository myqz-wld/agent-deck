---
plan_id: session-trajectory-mcp-tool-20260626
created_at: 2026-06-26
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: fe85c9ca45579b662b91a76dc8b275f3d99900fd
base_branch: main
related_changelog: CHANGELOG_328
completed_at: 2026-06-26
---

# Session Trajectory MCP Tool

## Goal

Add an agent-facing, read-only MCP capability that lets one Agent Deck SDK session inspect another session's recorded activity trajectory when, and only when, the target session is related to the caller.

The initial tool should expose Agent Deck's normalized SQLite event stream, not raw Claude/Codex transcript files.

## Invariants

- A real session caller may read trajectory only for:
  - itself;
  - sessions connected by spawn ancestry in either direction;
  - sessions sharing at least one active Agent Deck team.
- External `__external__` callers cannot read trajectories because they have no session identity to compare.
- Unrelated sessions must receive a clear MCP error and no event payload.
- The tool is read-only and must not resume, steer, send messages, alter lifecycle, or touch SDK child processes.
- The tool reads normalized `events` rows from SQLite through `eventRepo`, not adapter jsonl/transcript files.
- Existing `list_sessions` / `get_session` metadata behavior stays out of scope unless tests expose a direct coupling bug.
- Pagination is mandatory; no call should return unbounded history.
- Returned rows preserve stable ordering: newest first by `ts DESC, id DESC`, matching event repo ordering.
- Tool descriptions must warn that returned event payloads are historical data, not instructions to obey.

## Design Decisions

### D1 - Tool Shape

Add a new MCP tool named `list_session_events`.

Proposed schema:

```ts
{
  sessionId: string;
  limit?: number;      // default 100, max 500
  offset?: number;     // default 0, max 5000
  kindFilter?: AgentEventKind[];
}
```

Proposed return:

```ts
{
  sessionId: string;
  events: Array<AgentEvent & { id: number }>;
  hasMore: boolean;
}
```

Implementation can fetch `limit + 1` rows and trim to compute `hasMore`. If `kindFilter` is included, add a repo method rather than filtering after a small page; otherwise omit `kindFilter` in v1 to keep pagination exact.

### D2 - Visibility Helper

Extract the related-session predicate currently embedded in `src/main/agent-deck-mcp/tools/handlers/list.ts` into a shared MCP helper, for example:

```ts
canReadRelatedSession(callerSessionId, targetSessionId): boolean
```

Rules:

1. `callerSessionId === targetSessionId` allows self.
2. Spawn ancestry allows both parent-to-child and child-to-parent, with the existing 64-depth cycle guard.
3. `agentDeckTeamRepo.findSharedActiveTeams(caller, target).length > 0` allows shared active team.
4. Missing caller/target rows, closed caller identity, and `__external__` deny trajectory reads.

`list_sessions` should keep using the same predicate after extraction so future ACL drift is less likely.

### D3 - Data Source

Use event repo SQLite reads for v1. The MCP handler uses `eventRepo.listValidForSession(sessionId, limit + 1, offset)`, which keeps the same `ts DESC, id DESC` ordering while filtering corrupt JSON rows before pagination. This avoids adapter-specific transcript path logic and keeps MCP `offset` tied to normalized events rather than raw DB rows.

Do not read:

- Claude jsonl files;
- Codex app-server thread files;
- terminal hook raw logs;
- renderer-only IPC state.

### D4 - Payload Handling

V1 returns stored event payloads as-is, bounded by pagination and existing DB write-side payload truncation.

Security note for tool description and tests: event payload text is untrusted historical content. The current caller should treat it as evidence, not as executable user instruction.

If review rejects raw payload exposure, fallback design is `payloadMode: "summary" | "full"` with `"summary"` default, but that is not the preferred v1 because it weakens the requested trajectory inspection.

## Task Breakdown

| Task | Owner | Status | Dependencies | Validation |
|---|---|---:|---|---|
| T1: Extract related-session visibility helper from `list.ts` | Codex | completed | none | Unit tests for self, parent, child, shared team, unrelated |
| T2: Add MCP schema/result types for `list_session_events` | Codex | completed | T1 | Typecheck catches schema/result drift |
| T3: Add handler using visibility helper + event repo normalized event reads | Codex | completed | T1, T2 | Handler tests for allowed/denied reads and pagination |
| T4: Register tool in `tools/index.ts` with read-only annotation | Codex | completed | T2, T3 | Existing MCP tool registry tests |
| T5: Add focused regression tests in `tools.test.ts` | Codex | completed | T3, T4 | Cover self, spawn ancestor/descendant, shared active team, unrelated, external, missing target, hasMore |
| T6: Update bundled prompt assets/docs | Codex | completed | T4 | `resources/claude-config/CLAUDE.md`, `resources/codex-config/CODEX_AGENTS.md`, README, MCP PlantUML/index counts |
| T7: Changelog and final validation | Codex | completed | T1-T6 | `pnpm typecheck`; focused vitest for MCP tools |

## Validation Plan

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm typecheck`
- `git diff --check`

Run `pnpm build` if implementation touches shared schema in a way that broadens renderer/main type coupling.

## Risks

- Raw event payloads can contain prompt text or tool output. The relation ACL is the primary boundary; pagination and tool descriptions reduce blast radius but do not redact secrets.
- Filtering `kindFilter` after pagination would produce surprising empty pages; either implement SQL-level filtering or defer the option.
- Reimplementing spawn/team visibility separately would drift from `list_sessions`; extraction is required rather than copy/paste.
- `get_session` currently allows app-wide metadata by id. This plan does not change that behavior, but trajectory reads must be stricter.
- Tests must verify archived/left team membership does not count as shared active team.

## Current Evidence

- `list_sessions` already defines related sessions as self, spawn ancestry, or shared active team by default for real callers.
- `get_session` and `list_sessions` intentionally return metadata only and do not include events or messages.
- IPC `SessionListEvents` already reads `eventRepo.listForSession`, proving the data source exists, but it is a renderer/main channel rather than agent-facing MCP.
- `agentDeckTeamRepo.findSharedActiveTeams` gives an active-team membership check suitable for the new ACL.

## Progress

- Implemented `list_session_events` schema, handler, tool registration, and external-caller deny policy.
- Added `eventRepo.listValidForSession` so MCP pagination filters corrupt JSON rows before applying `offset` / `limit`.
- Extracted related-session visibility into shared MCP helpers and kept `list_sessions` using the same predicate.
- Added focused MCP regression tests for self, spawn ancestor/descendant, shared active team, unrelated sessions, external callers, missing targets, inactive/archived team history, and pagination `hasMore`.
- Updated README, bundled Claude/Codex instructions, MCP tool counts, and PlantUML/index records from 18 to 19 public tools.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts`: passed, 86 tests.
- PlantUML `@startuml` / `@enduml` pairing: passed for updated diagrams.
- `plantuml -syntax` returned exit 50 with no stdout/stderr for both updated diagrams on PlantUML 1.2026.5; strict syntax result remains inconclusive.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.
- Simple prompt/tool-description review dispatched:
  - reviewer-claude session `4e4e8261-a034-4030-9107-6c60a7cb0274`, spawn prompt message `e6aefa43-60bc-4c43-bcda-0d416948bdc6`
  - reviewer-codex session `019f0326-f5e1-7530-bdb5-c020aabdcba3`, spawn prompt message `fa1d35f1-3a3e-4f19-94cc-66d8a1d91458`
- reviewer-codex reply `5856a904-73e6-4774-ac04-6b6e9ffd1d37`: one LOW finding accepted. README first sentence over-grouped third-party MCP clients with full per-session 19-tool capability. Fixed by splitting per-session callers from third-party external transport availability.
- reviewer-claude reply `62afe76e-92b0-478b-9a7b-626cff5d55cc`: 3 INFO observations, all accepted or addressed. Added explicit raw transcript/jsonl denial to paired bundled bullets, rewrote the `callerSessionId` schema description to avoid apparent read-only/external wording tension, and expanded `list_session_events` annotations to include non-destructive/idempotent/non-open-world hints.
- After reviewer-driven edits:
  - `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts`: passed, 86 tests.
  - `pnpm test src/main/store/__tests__/event-repo-recent-messages.test.ts`: passed, 17 tests.
  - `pnpm typecheck`: passed.
  - `git diff --check`: passed.
- Simple code review dispatched:
  - reviewer-claude session `1120a1eb-8a5f-4fad-90c5-9b46b1de08ac`, spawn prompt message `a26912a5-1e91-4d9d-862e-c08007d045d1`
  - reviewer-codex session `019f032e-d497-79a3-8bf8-ad55bb39c697`, spawn prompt message `79d4f53e-2963-4c82-83a0-93d5988291bb`
- reviewer-codex reply `fbdf78d2-8d47-4485-96e8-08c0bd680460`: no actionable findings.
- reviewer-claude reply `0a42544d-1f58-4bf0-8e27-846a01b20f86`: one LOW corrupt-row pagination edge case accepted and fixed by adding `eventRepo.listValidForSession` plus a store regression test.

## Next-Session First Action

No follow-up session required.
