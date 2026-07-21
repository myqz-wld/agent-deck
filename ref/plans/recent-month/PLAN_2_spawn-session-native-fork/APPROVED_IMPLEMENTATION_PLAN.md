---
plan_id: spawn-session-native-fork-20260709
status: approved
created_at: 2026-07-09
base_commit: c509d95b14c93d484100df269a6c829927dec373
worktree_path: /Users/wanglidong/Repository/agent-deck/.agent-deck/worktrees/feat__spawn-session-native-fork-20260709
work_branch: feat/spawn-session-native-fork-20260709
approved_at: 2026-07-09
archived_at: 2026-07-10
archive_role: approved-implementation-plan
related_final_plan: ../PLAN_2_spawn-session-native-fork.md
---

# Native Fork Context For `spawn_session`

## Goal

Add an opt-in native conversation fork to Agent Deck MCP `spawn_session` for
`claude-code`, `deepseek-claude-code`, and `codex-cli`, while preserving the current fresh-session
path as the default.

The feature must let a same-adapter child inherit provider conversation context without cloning
Agent Deck application state such as tasks, teams, messages, file-change records, or worktree
ownership.

## User-Visible Contract

Add one optional argument:

```ts
contextMode?: 'fresh' | 'fork'
```

- Omitted means `fresh`; normalize inside the handler instead of using a Zod default so omitted
  calls retain the existing parsed shape.
- `fork` always forks the authenticated caller. Do not expose `sourceSessionId`, native transcript
  IDs, or arbitrary-session selection.
- `fork` requires the target adapter to exactly match the caller adapter.
- `fork` requires the target `cwd` and source `cwd` to resolve to the same real path.
- Never silently downgrade a requested fork to a fresh session.
- For a first-turn Codex caller, `fork` uses the documented zero-prefix behavior: it creates an
  independent target thread and replays the current native `UserInput` values before the delegated
  prompt because no completed prefix exists to pass to `thread/fork`.
- A successful fork response adds fork-only provenance:

  ```ts
  contextMode: 'fork'
  forkedFromSessionId: string // Agent Deck application SID, never provider-native ID
  ```

  Fresh responses remain unchanged.

The MCP field and tool descriptions must state these rules and provide exact correction hints.

## Context Boundary

Use the safe active-turn boundary:

- Include all prior provider history and the current user request.
- Exclude the parent assistant's unfinished reasoning, output, and `spawn_session` tool call.
- Do not wait for the parent turn to finish; doing so is circular because the MCP tool result cannot
  exist until `spawn_session` returns.

Provider mapping:

- Codex: read the source thread, retain only `userMessage` inputs from the current in-progress turn,
  and fork through the immediately preceding terminal turn. Start the child with those current
  user inputs followed by the normal delegated spawn prompt. If the source is in its first turn and
  has no terminal prefix, create a documented zero-prefix child and use the same combined first
  input; there is no safe provider prefix to copy, but the child still receives all model-visible
  source context available under this strict boundary.
- Claude-family: resolve the active main-chain transcript entries with their original provenance
  metadata and fork inclusively through the latest real, querying, non-synthetic top-level user
  message. This includes the current request while excluding the active assistant/tool-use frame.
- If no safe boundary exists, return a provider-specific error and suggest `contextMode: "fresh"`.

## Invariants

1. Omitted or explicit `fresh` behavior remains byte-for-byte equivalent through adapter dispatch.
2. The authenticated caller is the only fork source; request arguments cannot spoof it.
3. Source `sessions.id` and `cliSessionId` are never mutated.
4. Source and child have independent provider-native IDs and independent Agent Deck session rows.
5. Explicit target model/thinking/agent settings keep current precedence:
   explicit MCP argument > resolved target agent config > provider default.
6. Same-adapter permission/sandbox/write-root inheritance remains unchanged.
7. Provider history is cloned; Agent Deck tasks, teams, team roles, DB messages, summaries,
   checkpoints, worktree markers, and file undo history are not cloned.
8. A fork remains a normal parallel spawn: depth, fan-out, rate limits, spawn link, reply anchor,
   team handling, and placeholder behavior are unchanged.
9. `hand_off_session` remains a cold/fresh successor path and never requests a fork.
10. Native IDs are never exposed as normal MCP result fields, wire prefixes, or team data. Raw
    provider diagnostics remain available in this local application, matching existing Claude and
    Codex observability; callers still cannot submit a native ID as input.
11. Native fork failures do not create spawn links, team members, or reply placeholders.
12. A requested fork never silently falls back to ordinary context-free fresh creation or prompt
    serialization. The one explicit Codex first-turn case is a documented zero-prefix bootstrap
    that replays the exact current `UserInput` values because no terminal provider prefix exists.

## Confirmed Evidence

### Codex

- Installed Codex app-server `0.144.0` exposes `thread/fork`, `thread/delete`,
  `thread/inject_items`, and `Thread.forkedFromId`.
- `ThreadForkParams` requires `threadId`; `lastTurnId` is optional and cannot name an in-progress
  turn.
- A local protocol spike confirmed `thread/fork` returns a new canonical thread ID, records
  `forkedFromId`, and applies a target reasoning-effort override.
- Omitting `lastTurnId` is not sufficient for this feature's strict boundary: the documented
  interruption marker makes the partial suffix well-formed but does not promise removal of partial
  assistant/tool items. The implementation therefore reads the source turn, forks through the
  prior terminal turn, and replays only the active user inputs into the child first turn.
- A new target-owned app-server client is required because each Agent Deck Codex client has a
  frozen per-session MCP bearer token. Forking and running the child on the caller's client would
  authenticate child MCP calls as the parent.
- OpenAI tracks a current app-server bug where a `developerInstructions` override supplied to
  `thread/resume` or `thread/fork` may not reach the first model turn. The implementation must
  append the full effective target instructions as a developer-role item with
  `thread/inject_items` before the first child prompt, while still passing them at thread scope.
- Primary references:
  - https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/app-server/README.md
  - https://github.com/openai/codex/issues/19045

### Claude-family

- Installed Claude Agent SDK `0.3.205` exports `getSessionMessages`, `forkSession`, and
  `deleteSession`.
- `forkSession` is a transcript-file operation that accepts inclusive `upToMessageId`, remaps UUID
  and parent chains, clears copied team/agent metadata, and returns a resumable fork UUID.
- Query-side `forkSession: true` is not suitable here: its safe rewind option is documented for
  assistant UUIDs and cannot include the current user request while excluding the active assistant
  tool call.
- Existing Agent Deck `cliSessionId` tracking already preserves the actual transcript ID across
  Claude implicit/phantom fork behavior.
- Primary reference:
  - https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser

## Eligibility And Error Contract

Run generic fork-only preflight after agent/model option resolution and the caller DB lookup, but
before spawn guards reserve capacity and before team creation. Call the adapter's read-only
`validateForkSession` at this point for deterministic provider constraints such as DeepSeek's
transcript root.

Require:

- caller row exists;
- `source === 'sdk'`;
- `lifecycle === 'active'`;
- `archivedAt === null`;
- non-empty `cliSessionId`;
- exact caller/target adapter match;
- source and target realpath-equivalent `cwd`;
- adapter exposes native fork capability, validation, and implementation.

Reject dormant, closed, archived, missing, hook-only, uninitialized, cross-adapter, cross-cwd, and
missing-native-ID sources without consuming a guard token or mutating team state.

Use actionable errors, for example:

- `contextMode "fork" requires caller adapter "codex-cli", received "claude-code". Retry with the
  caller adapter or use contextMode "fresh".`
- `Cannot fork an archived caller session. Restore it or use contextMode "fresh".`
- `Caller session has no resumable provider session ID. Retry after SDK initialization or use
  contextMode "fresh".`
- `Fork source and target cwd must resolve to the same directory. Use the caller cwd or use
  contextMode "fresh".`

Preserve the underlying provider diagnostic and add a fork-specific hint. Do not replace it with
the generic model/thinking failure hint. Native IDs may remain in the local diagnostic text, but
they are never promoted to callable schema fields.

Eligibility is authorized at the preflight point. If the user closes or archives the parent after
the fork request has passed preflight, the already-authorized child creation may finish; do not add
a second lifecycle check that races normal user-initiated spawn completion.

## Adapter Contract

Add provider-neutral optional adapter operations instead of exposing provider-native IDs through
normal create options:

```ts
interface ForkSessionSource {
  applicationSessionId: string
  nativeSessionId: string
  cwd: string
}

interface ForkedSessionHandle {
  sessionId: string
  discard(): Promise<void> // idempotent; deletes only the child app/runtime/native history
}

validateForkSession?(
  source: ForkSessionSource,
  target: CreateSessionOptions,
): Promise<void>

createForkedSession?(
  source: ForkSessionSource,
  target: CreateSessionOptions,
): Promise<ForkedSessionHandle>
```

Add `canForkSession` to adapter capabilities. Claude, DeepSeek, and Codex advertise support;
DeepSeek can still reject at runtime when its transcript root is incompatible.

The MCP handler builds target options once with `buildCreateSessionOptions`, calls read-only fork
validation before guards/team mutation, then dispatches to `createSession` or
`createForkedSession`. It retains the fork handle until mandatory team membership succeeds. On a
membership failure, it invokes `discard()` after the existing child close/delete path so native
history cannot become an unreachable orphan. This keeps the existing options builder and its
compile-time passthrough assertions free of provider source IDs.

## Claude And DeepSeek Design

Create a focused Claude-family fork helper used by both adapters:

1. Load the Claude SDK through the existing ESM loader.
2. Use `getSessionMessages` to obtain the active main-chain UUID order, and parse the corresponding
   raw JSONL entries to retain `isSynthetic`, `shouldQuery`, `origin`, `tool_use_result`,
   `parent_tool_use_id`, and content metadata that the SDK summary API strips. Resolve the JSONL
   from the same effective config root/project bucket used by the standalone SDK operation; do not
   hardcode `~/.claude`. Parse only complete JSON lines and tolerate a concurrently appended partial
   trailing line.
3. Walk the active chain backward to the latest top-level user entry with
   `isSynthetic !== true`, `shouldQuery !== false`, no `tool_use_result`, and at least one content
   block other than `tool_result`. Synthetic textual reminders and hook messages are not eligible.
4. Call `forkSession(source.nativeSessionId, { dir: source.cwd, upToMessageId, title })`.
5. Start the child through the existing bridge resume path using the returned fork UUID as the new
   application/native ID and the already-built target options/prefixed prompt.
6. Return only the Agent Deck child ID.

On failure after the transcript fork is materialized:

1. best-effort close any child bridge state;
2. best-effort delete an accidentally created Agent Deck child row, never the source row;
3. best-effort call SDK `deleteSession(forkId, { dir: source.cwd })`;
4. log cleanup failures without masking the original error.

DeepSeek's read-only `validateForkSession` permits the helper only when its effective
`CLAUDE_CONFIG_DIR` matches the main-process Claude transcript root. If a custom DeepSeek root
differs, reject before guards/team mutation with a hint explaining that native fork cannot safely
locate that transcript. Do not mutate process-wide environment variables to work around the
mismatch.

## Codex Design

Implement a dedicated eager fork path in the Codex bridge:

1. Use the caller's existing live app-server client only to read its own source with
   `thread/read({ includeTurns: true })`. Require an in-progress source turn,
   capture every `userMessage.content` item from that turn in order, and ignore its `agentMessage`,
   `reasoning`, command, file, and tool-call items. This same-client read is required because a
   second process is not guaranteed to expose authoritative live `inProgress` state.
2. Allocate a temporary child application identity, MCP token, and target-owned app-server client
   using the same target runtime configuration as a fresh session. Do not create a DB row yet.
   Child fork/start/turn execution must use this target client, never the caller client.
3. Identify the immediately preceding terminal turn. When present, call `thread/fork` on the target
   client with that
   turn's ID as `lastTurnId` and all target thread settings. When absent, call `thread/start` for a
   zero-prefix child and mark this internal branch explicitly for tests/diagnostics; it still
   receives the exact captured current user inputs and is the documented first-turn fork semantic,
   not an unannounced downgrade.
4. Treat the returned thread ID as canonical. Create the temporary Agent Deck row only after native
   prefix creation succeeds, then adopt the canonical ID through the existing atomic
   `sessionManager.renameSdkSession(temp, canonical)` path so DB children, SDK claims, token maps,
   client maps, and renderer identity move together.
5. Before the child turn, call `thread/inject_items` with a later developer-role reset item. The
   item must explicitly state that inherited source Agent Deck/custom-agent instructions are
   historical and superseded, then include the complete effective target instructions (or an
   explicit empty-target reset). This works around OpenAI issue #19045 for generic-to-agent,
   agent-to-generic, and agent-A-to-agent-B forks.
6. Build the first child `turn/start` input from the captured current-turn `UserInput` values in
   order, a clear delegation boundary, and the normal prefixed spawn prompt/attachments. This
   preserves text/image/skill/mention inputs while excluding every unfinished assistant/tool item.
7. Emit/persist the normal first child user event only after canonical rename and ensure the child
   token resolves to the canonical child before any child MCP call.

Failure rules:

- Source read or native prefix-creation failure is synchronous to `createForkedSession` and leaves
  no Agent Deck child.
- Before native creation: dispose the target client and release the temporary token/claim.
- After native creation but before a temp DB row: additionally call `thread/delete`.
- After temp row creation but before canonical rename: delete the temp row/map entries, native
  thread, claims, token, and client.
- After canonical rename but before method return: delete both possible temp/canonical map keys,
  the canonical DB row, native thread, claims, token, and client.
- If registration succeeded but the first `turn/start` later fails, keep the valid child session
  and surface the existing in-session error event rather than pretending no fork was created.
- Never execute the child on the caller's app-server client.

## MCP Lifecycle Integration

After successful adapter creation, reuse the existing normal-spawn ordering:

1. write `spawnedBy` and depth before releasing the fan-out reservation;
2. persist target permission/sandbox/model/thinking metadata;
3. apply optional title;
4. add explicit team memberships; on mandatory membership failure, run the fork handle's
   idempotent `discard()` after the existing child close/delete path;
5. insert and mark the normal reply-anchor placeholder;
6. return session ID, anchor, limits, and fork-only provenance.

Do not infer team membership from copied provider context. Standalone forks remain teamless-DM
capable exactly like fresh standalone spawns.

## Prompt And Documentation Assets

Before editing AI-facing assets, the implementation session must use `prompt-asset-improver`:

- inventory and back up the confirmed files;
- keep all prompt/tool-schema prose in English;
- update paired Claude/Codex runtime assets together;
- state exact input schema, same-adapter/same-cwd boundary, safe active-turn semantics, default
  fresh behavior, result provenance, and correction hints;
- avoid suggesting that `fork` accepts a turn count or arbitrary source session;
- validate paired-resource semantic parity after edits.

Expected assets:

- `src/main/agent-deck-mcp/tools/schemas/spawn.ts`
- `src/main/agent-deck-mcp/tools/index.ts`
- `resources/claude-config/CLAUDE.md`
- `resources/codex-config/CODEX_AGENTS.md`
- `README.md`
- the next repository changelog record

## Implementation Tasks

### T1 — Public MCP contract and preflight

Write area:

- `src/main/agent-deck-mcp/tools/schemas/spawn.ts`
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts`
- a focused preflight helper if needed to keep `spawn.ts` within the 500-line source limit
- MCP tests

Work:

- add `contextMode` schema and fork-only result fields;
- implement pure fork preflight before guards/team creation;
- build target options once and dispatch the appropriate adapter method;
- preserve fresh behavior and hand-off behavior;
- add fork-specific errors and hints.

Dependencies: T2 adapter contract.

### T2 — Provider-neutral adapter contract

Write area:

- `src/main/adapters/types/agent-adapter.ts`
- `src/main/adapters/types/capabilities.ts`
- a small fork-source type module/export if needed
- adapter capability declarations

Work:

- add `ForkSessionSource`, `ForkedSessionHandle`, `canForkSession`, read-only
  `validateForkSession`, and `createForkedSession`;
- keep native source IDs out of `CreateSessionOptionsRaw` and the normal options builder.

Dependencies: none.

### T3 — Claude-family fork implementation

Write area:

- new `src/main/adapters/claude-code/fork-session.ts`
- `src/main/adapters/claude-code/index.ts`
- `src/main/adapters/deepseek-claude-code/index.ts`
- focused Claude/DeepSeek tests

Work:

- implement active-chain plus raw-provenance boundary selection;
- fork and resume a distinct child;
- guard DeepSeek transcript-root compatibility;
- implement scoped cleanup without touching the source.

Dependencies: T2.

### T4 — Codex app-server fork implementation

Write area:

- `src/main/adapters/codex-cli/app-server/client.ts`
- `src/main/adapters/codex-cli/app-server/thread-params.ts`
- Codex bridge create/fork lifecycle modules
- `src/main/adapters/codex-cli/index.ts`
- focused Codex tests

Work:

- add source-read, `thread/fork`, `thread/inject_items`, and `thread/delete` client helpers;
- implement terminal-prefix fork / zero-prefix bootstrap and current-user input replay;
- implement target-owned eager creation and atomic temp-to-canonical registration;
- inject an explicit instruction reset plus effective target instructions before the first prompt;
- close every pre/post-rename rollback gap.

Dependencies: T2.

### T5 — Prompt assets, docs, and integration tests

Write area:

- MCP descriptions and paired runtime resources listed above
- `README.md`
- changelog
- cross-adapter MCP tests

Work:

- run the prompt-asset workflow and update English contracts;
- cover fresh compatibility, fork success, all preflight failures, error hints, teamless/team paths,
  spawn links, reply anchors, and hand-off freshness;
- verify tool argument rendering already exposes `contextMode`; do not add a DB migration or UI
  badge unless tests show the existing tool row is insufficient.

Dependencies: T1, T3, T4.

### T6 — Validation, review, and commit

Work:

- run focused tests during each task;
- run full validation;
- review source immutability, identity/token ownership, rollback paths, and paired prompt parity;
- fix all critical/high findings or disprove them with evidence;
- commit the fork feature separately from `c509d95`.

Dependencies: T1-T5.

## Test Matrix

### MCP

- omitted `contextMode` and explicit `fresh` use the existing create path and result shape;
- authenticated same-adapter fork succeeds for all three adapters;
- no public field can choose another source session;
- cross-adapter and cross-realpath-cwd forks reject before guards/team mutation;
- missing caller, non-SDK source, dormant/closed/archived source, and missing native ID reject;
- external/global-token callers remain denied;
- provider fork failure releases reservations and cleans a newly empty team;
- successful fork writes normal spawn link/depth and preserves source fields;
- explicit team and teamless reply-anchor behavior remain unchanged;
- `hand_off_session` always calls the fresh path.

### Claude-family

- latest normal user frame is selected even when followed by assistant `tool_use`;
- tool-result-only and synthetic textual user frames are skipped;
- a partial trailing JSONL line cannot move or corrupt the selected boundary;
- no safe user frame rejects without a full-copy fallback;
- returned fork ID becomes a distinct Agent Deck child;
- source transcript and source row remain unchanged;
- model/thinking/agent/sandbox target options reach the resumed fork;
- post-fork create failure attempts transcript and DB cleanup;
- DeepSeek default root works and a mismatched custom root rejects clearly.

### Codex

- source read captures current user inputs but excludes every current assistant/reasoning/tool item;
- the source read is issued on the caller-owned client while active; fork/start and all child work
  are issued on the target-owned client;
- a two-client integration test pauses the source inside a tool call, proves same-client
  `thread/read` completes without deadlock, and then forks the terminal prefix on the target client;
- exact `thread/fork` payload contains the source native ID, preceding terminal `lastTurnId`, and
  target settings;
- first-turn sources use the explicit zero-prefix branch and still receive current user inputs;
- returned ID is canonical; `forkedFromId` matches the source when a terminal prefix exists, while
  the documented zero-prefix case has only Agent Deck `forkedFromSessionId` provenance;
- target client/token identity is renamed before child MCP availability;
- caller client is never used for child turns;
- an explicit supersession/reset plus full target developer instructions is injected before
  `turn/start` and is the latest developer-visible history item;
- an app-server test with a local capture/fake provider (or an equivalent raw-request harness)
  verifies the first `/responses` request contains the reset/target instructions after inherited
  source instructions for generic-to-agent, agent-to-generic, and agent-A-to-agent-B cases;
- the first child model request contains current user inputs plus the delegated prompt, but no
  source reasoning, assistant text, command/tool call, or missing tool result;
- source in-progress turn remains untouched and is not interrupted;
- fork RPC failure fully rolls back;
- fault injection before native creation, after native creation, after temp registration, and after
  canonical rename proves both IDs are absent from the DB, sessions/client maps, SDK claims, and
  MCP token reverse lookup; native child history is deleted and the source remains intact;
- post-fork registration failure attempts `thread/delete`;
- first-turn failure after registration leaves a valid errored child.

## Validation Commands

Run from the isolated implementation worktree with the repository's declared Node/pnpm runtime:

```sh
pnpm exec vitest run <focused MCP, Claude, DeepSeek, and Codex fork tests>
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Also run the prompt-asset validation/inventory refresh required by `prompt-asset-improver`.

Main/preload changes normally require an Agent Deck application restart for manual validation. Do
not restart the currently hosting app from inside the implementation session; report this deferred
manual verification explicitly.

## Risks And Mitigations

- **Dangling Claude tool call:** select the active-chain boundary using raw provenance, not content
  shape alone.
- **Codex partial active turn:** fork only the terminal prefix and replay only current user inputs.
- **Child authenticates as parent:** create Codex fork on a target-owned client/token and verify with
  an identity test.
- **Stale Codex developer instructions:** inject an explicit supersession/reset plus the full
  effective target instructions before the first turn, covering generic-to-agent,
  agent-to-generic, and agent-to-agent forks.
- **DeepSeek transcript root mismatch:** reject instead of mutating global environment or guessing.
- **Native orphan after partial failure:** delete only the newly materialized child best-effort and
  never mask the original failure.
- **Fresh-session regression:** keep a separate adapter method and assert omitted/explicit fresh
  behavior.
- **Misleading lineage:** copied provider history does not imply copied Agent Deck resources; retain
  only the existing normal `spawnedBy` relationship plus fork-only result provenance.
- **Large context cost:** native fork can carry a large history. Do not add a hidden truncation;
  document that `fresh` is the low-context alternative.

## Exclusions

- Cross-adapter context translation or serialized-history fallback.
- Arbitrary source session IDs or forking another visible teammate.
- Turn-count selection such as `forkTurns: 3`.
- Cross-cwd/worktree transcript relocation.
- Cloning tasks, teams, messages, worktree markers, summaries, checkpoints, or filesystem state.
- Changing `hand_off_session` to fork.
- Adding persistent fork-provenance DB columns or a dedicated UI badge in v1.
- Fixing the existing post-send placeholder insertion race.

## Approval Gate And Next Step

The selected defaults awaiting user approval are:

- `contextMode: 'fresh' | 'fork'`, default `fresh`;
- safe active-turn boundary;
- authenticated caller only;
- exact same adapter and same realpath cwd;
- conditional DeepSeek support with an explicit custom-root rejection;
- no silent fallback;
- no DB migration or dedicated UI badge.

After approval, create an isolated implementation worktree/branch, hand this plan to the successor,
and start with T2 followed by T1. T3 and T4 may then run in parallel with disjoint write sets.

Plan review completed with independent Claude, Codex, and MCP-lifecycle tracks. The initial findings
about synthetic Claude user frames, Codex partial-turn leakage, first-turn semantics, instruction
supersession, token/rename rollback, DeepSeek preflight timing, and post-team-failure native cleanup
are incorporated above. The Claude and Codex reviewers reported no remaining critical/high issues.
