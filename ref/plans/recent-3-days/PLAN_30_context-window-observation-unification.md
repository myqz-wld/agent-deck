---
plan_id: PLAN_30
title: Unify context-window observation and capacity resolution
status: completed
created_at: 2026-08-03
updated_at: 2026-08-03
approved_at: 2026-08-03
completed_at: 2026-08-03
base_branch: main
base_commit: 027fa817e32ab72faddb878bcf1d9b8bb506e9c3
worktree_path: /Users/wanglidong/Repository/agent-deck/.agent-deck/worktrees/agent-deck-019fc66e-45c-mscy450g
implementation_branch: codex/context-window-observation-unification
agent_deck_task_id: 48ee75bd-b117-410f-a7b8-8bfb83197842
related_changelog: CHANGELOG_428
related_review: REVIEW_210
---

# Unify context-window observation and capacity resolution

## Goal

Create one provider-neutral context-window observation abstraction and make live session telemetry,
continuation target sizing, recovery, and checkpoint-generator sizing consume it consistently.

## Invariants

- Treat a provider-reported effective runtime window as stronger evidence than a static model name.
- Keep current-context occupancy session-scoped; keep window capacity runtime-scoped.
- Never infer a window from transcript token estimates or run a paid semantic LLM call for a
  deterministic metadata lookup.
- Never let renderer or public MCP input claim a trusted context-window value.
- Preserve adapter-native runtime identity: Claude gateway, Codex model provider, Grok native
  runtime, concrete model, and capacity-affecting configuration must not collide.
- A newly learned observation must not mutate an already frozen handoff target or cause self-induced
  freshness failure.
- Unknown, stale, ambiguous, and observed capacities must remain distinguishable in types,
  diagnostics, and tests.
- No user database may be silently rewritten, discarded, or downgraded. For this task, prior-schema
  compatibility is explicitly excluded: a v61 database remains untouched and is rejected by the
  existing current-only startup policy after the baseline advances.

## Scope

### Included

- Provider-neutral runtime identity and context-window observation types.
- Claude, Codex, and Grok native observation adapters.
- Observation storage/resolution and freshness/provenance policy.
- Session context snapshot integration and stale-identity invalidation.
- Continuation target, recovery, foreground checkpoint, and background checkpoint consumers.
- Removal or compatibility retirement of the current `ContextCapacityResolver` minimum-only map.
- Deterministic fallback and at-most-one classified lower-budget retry behavior.
- Focused storage, adapter, resolver, handoff race, restart, and UI tests.
- Required schema/version, changelog, plan archive, and validation records.

### Excluded unless new evidence requires them

- Transcript-derived token counting as a substitute for provider telemetry.
- A public user setting for manually overriding model context windows.
- A hard-coded catalog of every provider model and marketing context-window claim.
- Changes to cumulative billing/token-ledger semantics.
- New network requests or paid model turns whose only purpose is capacity probing.

## Current evidence

- Live provider telemetry persists `{ usedTokens, windowTokens, updatedAt }` on each session and is
  rendered in session list/detail UI.
- Handoff/recovery ignores that snapshot and resolves capacity through a process-only map keyed by
  raw `adapter + model`.
- The map retains the minimum observation for the process lifetime and otherwise returns 128,000.
- Only checkpoint-generator calls feed the map. The generator snapshot itself always carries a null
  window, so learned generator observations do not size later generator input.
- Claude checkpoint generation takes the minimum across all reported model windows; Codex checkpoint
  generation returns no window; Grok can return one.
- Target resolution freezes capacity before generation, but generation can update the same global
  key; UI/MCP freshness re-resolution can therefore reject a preparation because of its own
  observation.
- The locally bundled Codex 0.146 protocol exposes `ThreadTokenUsage.modelContextWindow`; its model
  list projection does not expose a context-window field, and config only carries an optional
  override.
- Current focused coverage passes: 8 files, 106 tests.

## Blindspot pass

- Database policy is internally inconsistent: repository instructions require the next migration
  and `user_version`, while the current runtime intentionally contains only a current-schema
  baseline and rejects every non-current database. A persistent observation table therefore needs
  an explicit data-compatibility decision before route selection.
- `model` may be an alias before provider initialization and a concrete identifier afterward.
  Identity canonicalization must not merge aliases unless provider evidence proves equivalence.
- Claude result `modelUsage` may include secondary/subagent models. An observation must be attributed
  to the matched primary model or remain ambiguous; taking the minimum and labeling it as the
  configured model is unsafe.
- Codex reports an effective runtime window, which may differ from a raw public model limit because
  runtime catalog/config headroom is already applied. The effective value must not be adjusted a
  second time.
- A session can resume with changed model/provider settings. Persisted occupancy and capacity need
  separate invalidation rules.
- External hook-only sessions have no trusted native capacity channel and must remain explicitly
  unknown.
- Cache retention needs a bound, freshness rule, and deterministic tie-breaking when multiple
  observations disagree.
- A fallback that is conservative for 128k+ models can still exceed a smaller custom/gateway model.

## Candidate routes

### Route A — Durable runtime observation store (selected)

Introduce a dedicated runtime-keyed observation repository. Provider telemetry writes both the
session occupancy snapshot and a capacity observation through one service. Target/generator
resolution reads a frozen observation snapshot with source and freshness metadata.

Benefits: clean ownership, restart-safe reuse, exact provenance, testable conflict/TTL policy, and
no session-query coupling. The selected delivery advances the current schema baseline without
restoring historical migrations; non-current databases continue to fail closed without mutation.

### Route B — Reuse session snapshots as the persistent cache

Extend `sessions.context_usage` with runtime identity and resolve capacity by querying the newest
matching session; keep generator-only observations in memory.

Benefits: smaller schema surface. Costs: runtime capacity remains coupled to session lifecycle,
generator observations are not fully durable, queries and rename/deletion semantics become policy,
and the abstraction remains asymmetric.

### Route C — Process-only unified resolver

Feed live telemetry into a corrected runtime-keyed in-memory resolver and use it everywhere.

Benefits: smallest implementation. Costs: restart loses all learned state and leaves a confirmed
design defect intentionally unresolved. Not recommended for the requested abstraction goal.

## Decision ledger

| ID | Decision and impact | Owner | Options | Recommendation | Status | Evidence / answer |
|---|---|---|---|---|---|---|
| D1 | Persistence and database compatibility route | user | A: durable table; B: reuse session snapshots; C: process-only | A, current-only baseline | confirmed | User selected the dedicated table and explicitly excluded backward compatibility on 2026-08-03. Advance the current schema version; do not add or restore a migration chain; reject prior versions without mutation. This task-specific instruction overrides the root migration trigger for this change only. |
| D2 | Behavior when no fresh exact observation exists | user | A: explicit unknown with bounded small-model-safe prompt plus one shrink retry; B: retain 128k fallback warning; C: fail before handoff/generation | A | confirmed | User selected A on 2026-08-03. Exact initial and retry budgets remain an engineering spike outcome. |
| D3 | Capacity acquisition policy | user | A: provider-native passive telemetry/metadata only; B: add paid active probe; C: maintain static model catalog as primary | A | confirmed | User selected A on 2026-08-03. No new paid probe or static catalog as the primary authority. |
| D4 | Occupancy/capacity separation | engineering | Separate session occupancy from runtime capacity, joined by observation identity | separate | constrained | Different lifecycle and invalidation semantics; requested abstraction goal. |
| D5 | Frozen handoff semantics | engineering | Resolve once before preparation; later observations affect only future preparations | immutable snapshot | constrained | Prevents self-induced target drift and preserves existing freeze contract. |
| D6 | How to make the selected one-time retry observable before ownership transfer | user | A: gate unknown targets until first provider model activity or classified context rejection; B: use the small initial budget but do not retry provider rejection; C: gate every handoff | A | confirmed | User selected A on 2026-08-03. Only unknown-capacity trusted continuations use the readiness gate. A classified pre-activity context rejection may replace the candidate once; timeout, cleanup failure, other errors, or any post-activity failure do not retry. |
| D7 | How long a persisted cross-session capacity observation remains fresh | user | A: 7 days; B: 30 days; C: indefinitely | A | confirmed | User selected A on 2026-08-03. Rows remain available for diagnostics, but an observation older than seven days resolves as stale and cannot size a new target or generator. |
| D8 | Deterministic unknown-capacity budgets | engineering | Primary 64k logical window; retry 32k; generator unknown uses the 64k policy | 64k / 32k | constrained | With the existing 16k system/project and 8k response reserves, the target provider prompts are capped at 40k and 8k estimated tokens. An unknown generator receives a 32k fold-input budget after its existing 32k runtime/response reserve. |
| D9 | Observation replacement and conflict policy | engineering | Newest valid authoritative observation wins; source priority breaks equal timestamps; final equal-priority conflict uses the smaller value | newest | constrained | This permits provider-side capacity changes without the legacy process-lifetime minimum while retaining deterministic conservative behavior for an exact timestamp tie. |
| D10 | Readiness deadline | engineering | One 90-second absolute acceptance deadline shared by the primary and optional retry candidates | 90 seconds total | constrained | Aligns with the existing Codex and Grok first-model-event watchdogs while preventing two sequential 90-second waits. Startup, cleanup, and retry all consume the same deadline. |

## Checkpoints

- Checkpoint A — route selection: passed on 2026-08-03; D1-D3 confirmed.
- Checkpoint B — new evidence: passed on 2026-08-03; spikes complete and D6-D7 confirmed.
- Checkpoint C — final review: approved by the user on 2026-08-03; scope, task dependencies,
  rollback boundaries, validation matrix, and cold-start instruction are complete.

## Spike reports

### S1 — Current-only schema baseline

- Question: Can the selected durable table be added without restoring compatibility migrations?
- Method: inspected `src/main/store/db.ts`, `schema.ts`, `schema.sql`, and `db-schema.test.ts`.
- Result: the runtime reads the existing database before writable open, rejects every non-current
  `user_version` without mutation, and fingerprints the complete current schema. There is no active
  migration chain.
- Conclusion: add `context_window_observations` to the baseline, advance v61 to v62, and extend the
  existing fresh/current/old/partial schema tests. Do not add a migration file or compatibility
  branch for this task.
- Remaining risk: users with v61 cannot open it in the new build until they explicitly rebuild the
  test database; this is the user-confirmed D1 policy.

### S2 — Provider runtime identity availability

- Question: Can each native capacity event be attributed to a concrete runtime without guessing?
- Method: traced model/provider persistence and event order through Claude `system/init` and result
  translation, Codex thread startup/token notifications, and Grok ACP initialize/session setup.
- Result:
  - Claude synchronizes the primary runtime model from `system/init` before assistant/result usage;
    finalized `modelUsage` keys can identify the exact matched model.
  - Codex persists requested/configured provider and model before token events. Its app-server thread
    response can be retained instead of discarding all fields except id; if it still cannot provide
    a concrete model, the observation must remain session-only and not enter the durable runtime
    cache.
  - Grok negotiates and persists the ACP-reported effective model before queued prompt execution;
    `usage_update.used/size` can therefore use that identity.
- Conclusion: define a capacity identity from exact trimmed `adapter + runtimeProvider + concrete
  model`; do not canonicalize aliases across provider boundaries and do not persist a runtime
  observation when the concrete model is unknown. A later provider observation replaces an older
  value instead of keeping a process-lifetime minimum.
- Remaining risk: provider-side capacity-affecting configuration is not always exposed as an
  independent fingerprint; freshness expiry and newest-observation replacement bound that risk.

### S3 — Classified lower-budget retry boundary

- Question: Where can a real context-length rejection be caught before a handoff commits ownership?
- Method: traced `executePreparedHandOff`, `executeFreshSession`, and all three trusted-continuation
  create paths; inspected Codex structured turn errors and Claude/Grok result/error surfaces.
- Result: handoff considers creation successful after canonical session/runtime startup, while the
  initial model turn continues asynchronously. A context-window rejection therefore normally
  arrives after source ownership has already moved. Codex exposes structured
  `codexErrorInfo=contextWindowExceeded`; Claude and Grok require narrowly-scoped adapter-native
  error classification. No shared classifier or trusted-turn readiness promise exists today.
- Conclusion: a literal D2 retry requires an unknown-target-only readiness gate that waits for first
  provider model activity or a classified terminal context rejection, not the full response. On a
  classified rejection, clean the uncommitted attempt, deterministically render the smaller candidate
  from the same immutable spool/checkpoint, and create exactly one replacement. A timeout must fail
  before ownership transfer rather than guessing success.
- Remaining risk: this adds bounded latency and adapter lifecycle work to unknown-target handoffs;
  D6 explicitly accepts that scope for unknown targets only.

## Selected design

### 1. Runtime identity and observation contract

Add a provider-neutral `ContextRuntimeIdentity` with a versioned stable runtime key and explicit
`adapter`, `runtimeProvider`, concrete `model`, and capacity-affecting configuration fingerprint.
Claude native/Gateway, Codex `model_provider`, and Grok native runtimes remain separate namespaces.
Only adapter-owned native metadata may resolve an alias to a concrete model; generic model buckets,
display-name normalization, and cross-provider alias merging are forbidden.

`ResolvedContextCapacity` is a tagged result, not a number with a magic fallback:

- `observed`: exact identity, positive window, source, observation timestamp, and freshness deadline;
- `stale`: exact identity and retained diagnostic observation, but no usable sizing value;
- `unknown`: no concrete identity, no row, or ambiguous provider evidence, with an explicit reason.

The trusted sources are native usage telemetry, native runtime/model metadata, and effective native
configuration already loaded by the adapter. Existing checkpoint generation may contribute the
capacity returned as part of its semantic call; it does not trigger another call. Newer valid
observations replace older ones. Equal timestamps use source priority (`runtime-usage` above
`runtime-metadata` above `effective-config`), then the smaller capacity for an otherwise exact tie.

### 2. Durable store and current-only schema

Add `context_window_observations` to the current schema with one diagnostic row per versioned runtime
key. Store the decomposed identity, positive window, source, `observed_at`, optional originating
session, and the stable key used for exact lookup. Keep rows across session deletion and expiry; the
resolver applies a seven-day freshness threshold at read time.

Advance `CURRENT_SCHEMA_VERSION` from 61 to 62 and update the schema fingerprint/tests. Do not add a
migration or backfill. The existing read-only startup inspection must reject v61 and every other
non-current database without changing its bytes, `user_version`, tables, or rows. Rebuilding an old
development/test database is an explicit operator action.

### 3. One ingestion path for occupancy and capacity

Enrich native `context-usage` events with an attributable runtime identity when the adapter has one.
The main-process ingestion service performs one transaction that:

1. updates the session-scoped used/window snapshot;
2. resets carried occupancy/window fields before applying an event from a different runtime key;
3. upserts a durable capacity observation only when window, concrete identity, and trusted source
   are all present; and
4. emits the existing session update after persistence.

Partial events preserve fields only within the same runtime identity. Compaction still clears the
used count while retaining a same-identity window. Runtime provider/model changes invalidate the
display snapshot immediately, so the renderer never combines old occupancy with a new runtime.
Hook-only/external sessions and ambiguous native events may update attributable session occupancy
but cannot manufacture a durable capacity row.

Provider rules:

- Claude uses the effective primary model synchronized from `system/init`; finalized `modelUsage`
  must match that model exactly (or one authoritative Gateway mapping) before persisting a window.
  Secondary/subagent entries and ambiguous multi-model results do not contribute capacity.
- Codex keeps `Thread.model`/effective provider information instead of discarding it and pairs it
  with `ThreadTokenUsage.modelContextWindow`. `last.totalTokens` remains the current occupancy; no
  reasoning-token subtraction or second headroom adjustment is allowed.
- Grok pairs negotiated runtime model identity with ACP `usage_update.used/size`.
- Checkpoint generator results use their own exact generator identity and the same observation
  service; generator observations never attach to the handoff target identity.

### 4. Frozen resolution and deterministic rendering

Resolve target and generator capacity once into immutable tagged snapshots. Separate the target
configuration fingerprint from the capacity snapshot: freshness checks revalidate adapter/runtime
options and source revisions, but never query the capacity store again for an already prepared
handoff. A newly arriving same-key observation therefore affects only future preparations.

Observed targets use their exact effective window. Stale/unknown targets use a tagged 64k logical
window, producing a 40k provider-prompt ceiling with the existing reserves. During the same source
spool/checkpoint fold, prepare a second 32k logical-window rendering (8k provider-prompt ceiling).
Both candidates share the immutable source revision, checkpoint, instruction, and generator result;
the retry cannot recapture history or make another checkpoint-model call. If the authoritative
instruction plus wrapper cannot fit either selected ceiling, fail before creating a successor.

Unknown/stale generators use the 64k policy, yielding a 32k fold-input budget. A generator capacity
learned during that fold is persisted for future work only. Foreground handoff, recovery, and
background checkpoint refresh all call the same resolver and policy. Remove the 128k unseen-model
constant and the minimum-only process map after all consumers move.

### 5. Unknown-target acceptance gate and one retry

Introduce a main-only trusted-continuation candidate contract containing the stable session id and
an adapter-owned acceptance promise. Ordinary `createSession`/`spawn_session` behavior is unchanged.
For trusted continuations, each adapter resolves acceptance only on the first native model-derived
activity; lifecycle/config/echoed-user events do not count. It rejects with a narrow normalized
`context-window-exceeded` classification only when native evidence proves that condition. Codex
uses structured `codexErrorInfo`; Claude and Grok use allowlisted native error fields/codes, never
free-text substring matching as the sole authority.

Known fresh capacities retain the current create-and-cutover latency and do not await acceptance.
Unknown/stale targets follow this sequence under one 90-second absolute deadline:

1. create the 64k-policy candidate and await activity or classified terminal rejection;
2. on first model activity, continue the existing late-message, source-precondition, mandatory
   transfer, ingress-commit, and source-finalization sequence;
3. on a pre-activity context rejection, prove rollback cleanup with
   `closeSessionForRollback`; cleanup failure stops and reports the orphan without retrying;
4. create the pre-rendered 32k-policy candidate once and await the same acceptance boundary;
5. any retry rejection, timeout, non-context error, or post-activity failure closes best-effort and
   leaves source ownership untouched. No third candidate is allowed.

Late messages continue accumulating behind the source ingress lease during the gate and are
delivered only to the accepted candidate. The result/diagnostics identify whether the lower-budget
candidate was used without exposing provider prompts, spool ids, or trusted runtime fields.

### 6. Public/UI behavior and compatibility boundaries

The session header continues showing provider-reported occupancy, but only for the matching runtime
identity. Unknown, updating-after-compaction, and stale-identity states remain explicit. Existing
warning thresholds operate only when both used and window values belong to the same identity.

Public renderer/MCP inputs still cannot claim a trusted context window, observation source, runtime
key, or acceptance result. Any new output field is additive diagnostic metadata. No runtime setting,
manual override, network probe, marketing catalog, or compatibility migration is introduced.

## Execution task graph

Task records belong to umbrella task `48ee75bd-b117-410f-a7b8-8bfb83197842`. Dependencies are
mirrored in Agent Deck through both `blockedBy` and `blocks` edges.

| Step / task id | Deliverable and primary write area | Depends on | Completion evidence |
|---|---|---|---|
| T1 `4be9dd13-7f20-49e6-84a6-e52c02443b0b` | Core identity/resolution contracts plus v62 observation repository. Add focused modules under `src/main/session/context-window/`, `src/main/store/context-window-observation-repo.ts`, and update `schema.sql`, `schema.ts`, and DB/repository tests. | — | Exact-key, freshness, source-priority, replacement, restart, fresh-v62, and untouched-v61 rejection tests pass. |
| T2 `6b3c26c0-27ad-49ec-bc73-822d48ca6184` | Unified context-usage ingestion and runtime-bound session snapshot. Update `manager-ingest-pipeline.ts`, `session-repo/context-usage.ts`, shared session types/parsers, and focused manager/store tests. | T1 | Same-identity partial updates, identity change reset, compaction, stale-event, and no-identity behavior pass. |
| T3 `828788d3-53d5-413b-8ddb-d4e6e6d03992` | Claude attribution. Update Claude runtime metadata/context-usage/message translation and checkpoint-runtime primary-model matching; add ambiguity/Gateway tests. | T2 | Primary exact match persists; secondary/ambiguous/alias-only observations do not collide or persist. |
| T4 `45505f78-8904-4270-9258-3344948f28bd` | Codex attribution. Retain effective thread model/provider, translate effective `modelContextWindow`, propagate structured context rejection evidence, and cover app-server/bridge tests. | T2 | Raw current total, effective window, provider isolation, unknown placeholder, and structured rejection tests pass. |
| T5 `adfcc29e-a41f-4651-b6bb-97b212b8ad86` | Grok attribution. Pair negotiated native model with ACP usage, expose native rejection evidence, and cover translation/runtime tests. | T2 | `used/size` updates both scopes only under the negotiated identity; ambiguous/error paths remain unknown. |
| T6 `127c8520-37e7-43e5-bbb6-701d316991a0` | Frozen capacity consumers and dual unknown renderings. Refactor continuation resolver/types/service/budget policy/runtime/background refresh and recovery preparation; remove capacity from configuration freshness re-resolution. | T1 | Target/generator fresh/stale/unknown matrices, 64k/32k variants, same-spool determinism, restart reuse, and no self-invalidation tests pass. |
| T7 `48b706f4-35ac-47fc-9153-72d8962e733b` | Trusted-continuation acceptance and retry lifecycle. Extend adapter contract/fresh executor plus Claude/Codex/Grok readiness signals and handoff executor/coordinators. | T3, T4, T5, T6 | Known fast path, activity acceptance, classified retry, rollback-cleanup failure, second rejection, total timeout, late-message, and ownership invariants pass. |
| T8 `80f69218-34d9-4e17-9ff2-ecf8d99cc2a2` | UI/public diagnostics and legacy removal. Bind display snapshots to runtime identity, expose additive retry diagnostics, remove `ContextCapacityResolver`/128k fallback, and update labels/tests only where behavior changes. | T6, T7 | UI state tests, public-spoof/schema tests, and repository-wide search prove no legacy consumer remains. |
| T9 `8ab07916-587e-440b-8fd0-e84c2f8b0f7b` | Integrated validation, restart smoke, records, and review. Run all gates, archive this plan, write changelog/review records, and close tasks. | T8 | Required commands pass; final records/indexes are valid; worktree is clean and durable. |

Initial implementation action (completed): entered the recorded detached worktree, verified its
HEAD/cleanliness, created the implementation branch, and completed T1-T6 sequentially. Do not split
tightly coupled provider candidate contract changes across concurrent writers.

## Validation strategy

- Unit: exact identity canonicalization, provider/config separation, source priority, older/equal/newer
  timestamps, seven-day boundary, stale/unknown distinction, and 64k/32k deterministic budgets.
- Adapter contract: Claude primary-model attribution and ambiguity, Codex raw effective usage/window
  and structured rejection, Grok negotiated identity plus ACP `used/size`, generator observations,
  partial updates, and unsupported external sessions.
- Storage: fresh v62 schema/fingerprint, restart, row retention after expiry/session deletion, stale
  write rejection, session rename, and byte-for-byte unchanged v61 rejection with no migration path.
- Integration: provider event -> runtime-bound session occupancy + durable capacity -> frozen
  handoff/recovery/generator budget. Verify a same-key observation during generation cannot stale or
  resize the current preparation.
- Retry/lifecycle: known fast path; unknown primary acceptance; pre-activity classified rejection;
  proven rollback then exactly one smaller candidate; cleanup failure; second rejection; non-context
  error; total timeout; late-message ordering; cutover race; mandatory transfer failure; no ownership
  mutation before acceptance and transfer.
- UI/public boundary: unknown, compaction-updating, identity mismatch, current usage, warning
  thresholds, additive retry diagnostics, and rejection of forged window/source/runtime-key input.
- Focused commands: run affected Vitest suites through `pnpm test -- <paths>` using the Electron ABI,
  followed by `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm logger:check`,
  `bash scripts/file-level-review-expiry.sh`, file-size checks, `git diff --check`, and relevant
  schema/prompt-link checks.
- Runtime smoke: because main-process code changes, restart development only after automated gates
  and verify one known-capacity and one forced-unknown handoff path without disrupting unrelated
  active sessions.

## Model boundary

No new LLM call is required for context-window detection. Provider calls remain limited to the
existing semantic checkpoint-generation responsibility. Window identity, observation merge,
freshness, fallback sizing, persistence, freezing, and validation are deterministic code paths.

## Execution state

- Agent Deck umbrella task: completed (`48ee75bd-b117-410f-a7b8-8bfb83197842`).
- Last completed step: T9 final validation, converged heterogeneous review, isolated restart smoke,
  and delivery-record archival. Integration Round 3 remediation for T9 was committed as
  `fce0f761`. A private
  identity revision prevents rejected or successful settings operations from overwriting a newer
  reroute invalidation, and turn-output discards capacity evidence when a later event has null or a
  different exact identity. Integration Round 2 remediation remains `253a8c4f`: a sole Codex
  notification subscriber applies a turn-id-less reroute, while concurrent shared-client subscribers
  invalidate exact runtime identity. Integration Round 1 remediation remains `e4c18d88`: it
  requires target capacity config to match trusted identity evidence; bounds serialized runtime keys
  before persistence; removes or closes failed new Grok strict-startup registrations; and projects
  primary pre-stable-id startup failures through fixed safe IPC copy while preserving the one-shot
  pre-spawn retry.
  Round 7 coverage remains `13a03dfe`; production deadline remediation remains `204a5022`.
  Round 5 remediation is `a47887ec`;
  Round 4 remediation is `2db9e051`; Round 3 remediation is `38115ea7`;
  Round 2 remediation is `06dfdb21`;
  Round 1 remediation is `b90104b0`; T8 is `7e737f50`; T7 is `d180536f`; T6 is
  `cfa7dea5`; T5 is `3212c8f8`; T4 is `ccb2ed1f`; T3 is `82ceb92f`; the stateful
  session-repository mock spy repair is `955ee092`; earlier implementation commits are T2
  `ebb36259` and T1 `80b28223`.
- Current step: completed; no implementation or review work remains.
- Validation state: Integration Round 3 remediation at `fce0f761` passed 4 focused Electron-ABI
  files / 45 tests, the full Electron-ABI suite (462 files / 3814 tests, plus one skipped opt-in live
  smoke), `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, `git diff --check`, the review-expiry
  inventory, and production file-size checks. Integration Round 1 remediation at `e4c18d88` passed
  the full Electron-ABI suite
  (462 files / 3809 tests, plus one skipped opt-in live smoke), `pnpm typecheck`, `pnpm build`,
  `pnpm logger:check`, `git diff --check`, production file-size checks, legacy-consumer searches,
  and the review-expiry inventory. Round 2 remediation at `06dfdb21` additionally passed 9 focused
  files / 163 tests, typecheck, build, logger check, diff check, and production file-size checks.
  Round 3 remediation at `38115ea7` passed 10 focused files / 174 tests and the same static/build
  gates. Round 4 remediation at `2db9e051` passed 10 focused files / 167 tests, typecheck, build,
  logger check, review-expiry inventory, diff check, and production file-size checks. Round 5
  remediation at `a47887ec` passed 10 focused files / 169 tests and the same type/build/logger/diff/
  production-size gates. Round 6 remediation at `204a5022` passed 10 focused files / 171 tests and
  the same static/build gates. Round 7 coverage at `13a03dfe` passed 11 focused files / 175 tests and
  typecheck.
  T7 passed 12 files / 126 tests; T6 passed 41 files / 278 tests; T5 passed 30 files / 198 tests; T4
  passed 86 files / 573 tests; T3 passed 81 files / 499 tests; T2 passed 8 files / 70 tests; T1
  passed 4 files / 15 tests; original audit baseline remains 8 files / 106 tests.
- Workspace state at final validation: isolated worktree
  `/Users/wanglidong/Repository/agent-deck/.agent-deck/worktrees/agent-deck-019fc66e-45c-mscy450g`
  entered at `027fa817e32ab72faddb878bcf1d9b8bb506e9c3`; implementation branch is
  `codex/context-window-observation-unification`; reviewed implementation HEAD is `fce0f761`.
- Review state: user selected reviewer-claude + reviewer-codex. Claude workers use Gateway
  `deepseek`, model `deepseek-v4-flash[1m]`, thinking `max`; Codex workers use the inherited runtime.
  ADAPTERS converged at `38115ea7`, SURFACES at `204a5022`, and CORE at `13a03dfe`. INTEGRATION
  Round 1 completed at that head with five accepted/partial finding roots: concurrent unscoped Codex
  reroute attribution, exact Codex capacity-config equivalence, Grok strict-startup row cleanup,
  safe primary startup projection, and serialized runtime-key bounds. Round 1 remediation is
  `e4c18d88`. In Round 2 both reviewers independently confirmed that suppressing an ambiguous
  reroute still left the owning turn's pre-reroute identity falsely exact; `253a8c4f` invalidated
  identity for every concurrent subscriber. In Round 3 Claude found no residual, while Codex
  deterministically reproduced stale settings rollback and pre-invalidation turn-output evidence;
  those accepted MEDIUM orderings are fixed at `fce0f761`. Integration Round 4 then converged:
  both reviewers completed `253a8c4f..fce0f761`, reconstructed the stale-settings and stale-evidence
  counterexamples, marked the stable finding CLOSED, and reported zero new findings. The final
  review is archived as `REVIEW_210`.
- Accepted residuals: default/alias generator settings remain conservatively unknown until an exact
  runtime identity is configured; renderer same-adapter snapshot defense remains adapter-only because
  the authoritative full current runtime key is not projected; successful lower-budget retry is
  contract-visible but has no durable toast because the UI focuses the successor before the commit
  response returns. These are bounded LOW/product risks and do not weaken trusted input ownership.
- Restart smoke: the production build started in an isolated Electron profile on hook port 47822,
  initialized schema v62, mounted MCP, returned the expected unauthenticated 401 from `/mcp`, and
  shut down cleanly without touching the active Agent Deck host on 47821. Live-provider handoff
  calls were intentionally not made; their known/unknown paths are covered by the passing suites.
- Final records: `CHANGELOG_428`, `REVIEW_210`, and this archived `PLAN_30`.
- Blocker: none.
- Next action: normal branch integration/release workflow.

## Cold-start instruction

This plan is complete. Read `CHANGELOG_428` and `REVIEW_210` for the final behavior and review
evidence. Preserve current-only schema decision D1 and do not introduce migration compatibility,
manual capacity overrides, paid probes, static marketing catalogs, or public trusted fields without
a new approved plan.
