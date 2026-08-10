---
changelog_id: 353
changed_at: 2026-07-09
---

# CHANGELOG_353_spawn-session-native-fork: Add provider-native parallel session forks

## Summary

`spawn_session` can now create an explicit same-adapter, same-realpath-cwd native context fork from the authenticated active SDK caller. Fresh spawning remains the default. Forked children inherit prior provider history and the current user request while excluding the caller's unfinished assistant reasoning, output, tool activity, and active `spawn_session` frame.

## Changes

### MCP contract and orchestration

- Added optional `contextMode: "fresh" | "fork"` input without changing the omitted/default fresh result shape.
- Added fork-only `contextMode: "fork"` and Agent Deck `forkedFromSessionId` provenance; provider-native IDs remain private.
- Reject missing, external, non-SDK, inactive, archived, cross-adapter, cross-realpath-cwd, unsupported, or provider-ineligible fork sources before spawn guards reserve capacity or teams are mutated.
- Kept normal spawn links, depth accounting, target options, explicit-team/teamless behavior, reply anchors, and error hints for successful forks.
- Kept `hand_off_session` strictly fresh and rejected any internal attempt to combine handoff with a native fork.

### Claude and DeepSeek

- Selected the latest real top-level querying user frame from the SDK active chain plus complete raw JSONL provenance, then used the SDK's inclusive `forkSession(... upToMessageId)` boundary.
- Accepted current human, peer, channel, and coordinator requests while rejecting synthetic, tool-result, observer, notification, and non-querying user frames.
- Ignored partial trailing assistant JSONL data, rejected missing/partial/ambiguous transcript provenance, and never copied the active assistant/tool frame.
- Resumed only a distinct native child and made discard idempotently remove child runtime, coordinated application state, renderer state, and native history without mutating the source.
- Added read-only DeepSeek transcript-root compatibility checks without creating settings or mutating `process.env`.

### Codex app-server

- Read the active source turn only through the caller-owned live app-server client; target clients never infer source-turn state.
- Created terminal-prefix children through target-owned `thread/fork`, with an explicit independent `thread/start` zero-prefix branch for first-turn callers.
- Replayed only current native `UserInput` values before the delegated prompt and excluded source reasoning, assistant output, commands, and tool calls.
- Injected a developer-role supersession/reset plus complete effective target instructions before the first child turn.
- Registered a temporary child only after native creation/reset, atomically adopted the canonical ID across DB/runtime/client/token/claim ownership, and verified ownership before child MCP availability.
- Added child-only rollback at four fault phases. Post-close discard reopens the same target-owned client configuration solely to delete native child history; it never borrows the caller client or token.
- Separated replayed source image inputs from child-owned attachment cleanup so rollback cannot unlink a source upload.
- Forced `thread/resume` when the target process exits before canonical child adoption instead of treating the child as loaded in a dead process.
- Split the app-server thread runtime from `client.ts` so both files remain below the 500-line source limit.

### Prompt assets, documentation, and tests

- Synchronized the English fork contract across MCP schema/tool descriptions, bundled Claude/Codex runtime prompts, and README documentation.
- Added focused MCP compatibility/preflight/orchestration tests, Claude/DeepSeek boundary and wiring tests, Codex lifecycle/fault tests, a paused-tool-call two-client test, and a raw first-request instruction-reset capture for generic-to-agent, agent-to-generic, and agent-A-to-agent-B transitions.

## Validation

- Focused MCP, Claude, DeepSeek, and Codex fork suites passed.
- `pnpm typecheck`
- `pnpm test` — 202 files and 2207 tests passed.
- `pnpm build`
- `git diff --check`
- Prompt-asset backup manifest, original hashes, English wording, paired Claude/Codex semantic parity, JSON inventory, and post-edit hashes validated.

## Do Not Split Protection

`src/main/adapters/codex-cli/sdk-bridge/index.ts` was already a 639-line state-owning facade at the baseline and is 679 lines after adding two thin fork entry methods plus dependency wiring. The fork lifecycle itself is split across focused modules under `sdk-bridge/fork-session/`; moving only the facade wiring would expose its private session/client maps, target-client factory, and thread loop without creating an independent responsibility. Revisit the facade split when it reaches 700 lines or when another independent lifecycle feature would add more than 20 lines. All other newly expanded production source files are at or below 500 lines.

## Notes

- No database migration or fork UI badge was needed; the existing MCP tool rendering exposes the new argument automatically after the hosting application is restarted.
- No live-provider two-process test was run. Deterministic fake app-server/provider and two-client harnesses cover source/target ownership, request ordering, model-visible reset placement, and rollback.
- The configured adapter-based deep-review was stopped at the user's request; `REVIEW_144` records the replacement single-local-sub-agent review, blocking finding, fix, and passing re-review.
- The hosting Agent Deck application was not restarted because doing so would terminate this implementation session; restart it before interactive verification.
- Related plan: `PLAN_2_spawn-session-native-fork`.
- Related review: `REVIEW_144_spawn-session-native-fork-risk`.
