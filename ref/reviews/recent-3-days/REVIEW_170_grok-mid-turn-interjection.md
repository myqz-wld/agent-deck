---
review_id: 170
reviewed_at: 2026-07-24
baseline_commit: 16fb52ec36c7a77e355ffd6fe6821df669787d19
expired: false
---

# REVIEW_170_grok-mid-turn-interjection: Grok active-turn input audit

## Scope and method

This focused review traced the ordinary send path from renderer IPC through the Grok bridge and
turn queue, compared it with the forced enqueue path used by handoff/continuation, and inspected
the installed Grok implementation of the nonstandard interjection extension. Evidence included
source inspection, `git blame`, deterministic queue/ACP/UI tests, the full Electron test suite,
type checking, and a production build.

```review-scope
README.md
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/index.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/session-setup.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/runtime-profiles.ts
src/main/ipc/adapters-message-dispatch.ts
src/main/ipc/adapters-outgoing.ts
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/index.tsx
```

The local Grok source at `/Users/apple/Repository/personal/grok-build` was read as external
implementation evidence only; it is not part of this repository's patch.

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Ordinary Grok input was indistinguishable from handoff input: both entered the FIFO queue, while `drain` refused to start another prompt during `session/prompt`. Deferred user events made long active turns look stuck. | Split `send` from `enqueue`; active ordinary input calls Grok's `_x.ai/interject` wire extension, while handoff/continuation remains FIFO. |
| HIGH | ACP v1 does not define a portable mid-turn prompt insertion method; sending a second `session/prompt` concurrently could race the provider turn. | Use Grok's registered `x.ai/interject` extension instead of concurrent standard prompts. |
| MEDIUM | Older Grok binaries may not expose the extension. Treating that as a hard send failure would regress input delivery. | Cache a method-not-found result per runtime and fall back to the existing FIFO queue; explicit `steerTurn` still reports unsupported rather than silently changing semantics. |
| MEDIUM | Runtime startup grew beyond the repository's 500-line source guardrail as active-turn and usage handling were added. | Extract startup/background lifecycle into `runtime-start.ts`; the bridge is 481 lines after the split. |

## Protocol evidence

The local Grok implementation registers `x.ai/interject` in the ACP agent dispatcher. Its handler
accepts `sessionId`, `text`, optional `interjectionId`, and optional structured `content`, sends a
`SessionCommand::Interject`, and returns `{ status: "queued" }`. On the JSON-RPC wire, ACP routes
that extension as `_x.ai/interject`; the logical name without `_` is only the server-side
extension identifier. The session actor buffers the message for the next safe point in the running
turn and creates a fallback prompt when the turn ended during the race. This confirms that current
Grok Build permits true in-turn insertion, but through a vendor extension rather than ACP standard
v1.

The first client implementation used the bare logical method and was rejected by the installed
binary with `-32601 Method not found`. A no-cost initialize-only probe distinguished the forms:
`_x.ai/interject` reached the extension and returned `-32602 session not found` for a fake session,
while bare `x.ai/interject` and a guessed `ext_method` envelope returned `-32601`. The adapter was
corrected before final validation, and the fake ACP stdio fixture now verifies the prefixed wire
request end to end.

## Validation / evidence

- `pnpm typecheck` passed.
- `pnpm test` passed 357 files / 3,040 tests, with the repository's one skipped file and one skipped
  test unchanged.
- Focused Grok queue/ACP wire tests passed 11 / 11; the added stdio case exercises the SDK's
  underscore-prefixed extension request end to end.
- `pnpm build` passed.
- `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- Installed CLI reports `grok 0.2.110`; local source revision inspected was `40ada33` for the binary
  and the published source tree contains the extension registration.

## Residual risk and boundaries

- `x.ai/interject` is proprietary and not advertised by ACP capability negotiation. The adapter
  discovers support lazily on the first active send and safely falls back to FIFO on method-not-found.
- No paid live model interjection was sent during validation. Deterministic tests cover request
  shape, image blocks, fallback, event timing, and forced FIFO; the installed source was inspected
  for server-side drain semantics.
- A non-method-not-found extension transport error is surfaced instead of automatically queueing a
  second copy, because the provider may have accepted the interjection before the response failed.
- Handoff/continuation tails deliberately do not interject, even when the target Grok turn is busy;
  preserving ownership and replay order takes priority over latency.

## Follow-ups

No unresolved in-scope finding remains. A future Grok protocol capability advertisement or an
explicit request-cancellation/acknowledgement contract could replace lazy extension detection and
further improve transport-failure messaging.
