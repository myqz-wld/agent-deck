---
plan_id: PLAN_2
created_at: 2026-07-09
completed_at: 2026-07-09
status: completed
related_changelog: CHANGELOG_353
related_review: REVIEW_144
---

# PLAN_2_spawn-session-native-fork: Add safe provider-native parallel forks

## Goal

Add an opt-in `spawn_session(contextMode: "fork")` path that creates a parallel child from the authenticated active SDK caller's native provider context without copying an unfinished assistant/tool frame, crossing adapter/cwd boundaries, or weakening child identity and rollback ownership.

## Invariants

- Omitted `contextMode` and explicit `fresh` preserve the existing create path and result shape.
- A fork source is always the authenticated caller; no public source-session ID or turn count exists.
- Forks require an active, non-archived SDK caller, exact adapter match, and equal realpath cwd.
- A requested fork never silently falls back to fresh spawning.
- Provider-native IDs stay private; results expose only Agent Deck caller provenance.
- Target options are built once and keep normal model/thinking/agent/sandbox precedence.
- Claude-family forks stop inclusively at the latest real querying top-level user and never copy the active assistant/tool frame.
- DeepSeek validation reads its transcript-root configuration without creating settings or mutating process-wide environment.
- Codex reads live source-turn state only through the caller-owned client.
- Codex fork/start, reset injection, child turns, MCP token, and native deletion use target-owned clients and tokens.
- The Codex first-turn zero-prefix path replays native current `UserInput` values before the delegated prompt.
- Inherited Codex developer instructions are explicitly superseded and complete effective target instructions are injected before the first child turn.
- Temp/canonical rollback deletes only child application/runtime/native state at every phase and leaves the source unchanged.
- Team membership, spawn links/depth, teamless DM, reply anchors, and handoff-fresh semantics remain unchanged.

## Decisions

- Extend the provider-neutral adapter contract with read-only validation and an idempotent `ForkedSessionHandle.discard()` instead of adding source IDs to ordinary create options.
- Run all fork-only preflight before spawn guards and team mutation.
- Use Claude SDK `getSessionMessages` for active-chain order, complete raw JSONL for provenance, and `forkSession(... upToMessageId)` for inclusive history creation.
- Treat human, peer, channel, and coordinator origins as real querying users; reject synthetic, observer, notification, auto-continuation, tool-result, sidechain, and non-querying frames.
- Require complete active-user provenance and reject ambiguous transcript copies while tolerating a concurrently partial assistant tail.
- Use Codex `thread/read(includeTurns:true)` on the caller client, then `thread/fork(lastTurnId)` or an explicit `thread/start` zero-prefix branch on a distinct target client.
- Register the Codex child only after native creation and reset injection, then atomically rename DB/runtime/client/token/claim ownership to the canonical child ID.
- Keep first-turn failures as registered child failures, but fully roll back failures before registration/canonical adoption and later mandatory team-membership failures.
- Keep the public documentation and paired Claude/Codex runtime prompts semantically aligned in English.

## Completed Work

### T2 — Provider-neutral contract

- Added fork source/handle types, optional adapter validation/creation hooks, and `canForkSession` capabilities for Claude, DeepSeek, and Codex.

### T1 — MCP schema and preflight

- Added `contextMode`, fork-only provenance, generic/provider preflight, fresh/fork dispatch, retained-handle cleanup, and focused handler/preflight tests.
- Kept `hand_off_session` fresh and kept `spawn.ts` within 500 lines by extracting target-option and preflight helpers.

### T3 — Claude and DeepSeek

- Added safe boundary selection, transcript discovery/ambiguity checks, SDK-native fork/resume, coordinated child deletion, idempotent native cleanup, and DeepSeek transcript-root validation.
- Added boundary, partial-line, origin, ambiguity, lifecycle, source-immutability, option-passthrough, and adapter-wiring coverage.

### T4 — Codex

- Added app-server read/fork/start/inject/delete operations and exact current `UserInput` preservation.
- Added source-boundary selection, target runtime resolution, instruction reset, temp/canonical adoption, delayed first turn, and four-phase rollback.
- Added post-close native deletion through a fresh sibling of the target-owned client configuration.
- Split app-server thread execution from the client facade to keep both source files below 500 lines.
- Added lifecycle, raw first-request, exact payload, first-turn, two-client paused-tool-call, identity, and rollback tests.

### T5 — Prompt assets and documentation

- Updated MCP descriptions, paired runtime prompts, README, prompt inventory/backup records, and `CHANGELOG_353`.

### T6 — Validation and review

- Fixed independent audit findings covering Codex post-close native orphans, source-image ownership, target-process exit before adoption, Claude peer/channel/coordinator boundaries, transcript ambiguity/partial tails, coordinated renderer deletion, DeepSeek wiring, Codex two-client coverage, and MCP zero-prefix wording.
- The user replaced the unavailable adapter-based reviewer workflow with one local independent collaboration sub-agent; `REVIEW_144` records that explicit review-mode decision and its findings.

## Validation

- Focused MCP, Claude, DeepSeek, and Codex fork suites passed.
- `pnpm typecheck`
- `pnpm test` — 202 files and 2207 tests passed.
- `pnpm build`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Prompt inventory/backup hashes, paired runtime semantics, English-only changed prose, JSON validity, reset-template requirements, and new Markdown-link absence validated.

## Residual Risks

- No live-provider two-process test was run; deterministic fake app-server/provider and two-client harnesses cover request ordering and ownership.
- `src/main/adapters/codex-cli/sdk-bridge/index.ts` remains an existing over-500-line state-owning facade. Substantive fork logic is split; its concrete revisit trigger is recorded in `CHANGELOG_353`.
- The hosting Agent Deck application was not restarted, so interactive tool-schema rendering and live provider behavior require a deferred manual restart/check.

## Final Status / Handoff

Completed on branch `feat/spawn-session-native-fork-20260709` from baseline `c509d95b14c93d484100df269a6c829927dec373`. The next action is to commit the validated feature and fast-forward `main` only if its checkout is still clean at that baseline; otherwise retain this feature branch and report the divergence.

Completed At: 2026-07-09
