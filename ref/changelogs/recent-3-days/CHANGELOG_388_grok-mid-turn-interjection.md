---
changelog_id: 388
changed_at: 2026-07-24
---

# CHANGELOG_388_grok-mid-turn-interjection: Support Grok active-turn input

## Summary

Grok Build ordinary input now reaches an active provider turn through Grok's native
`x.ai/interject` extension (ACP wire method `_x.ai/interject`) instead of waiting behind the
FIFO prompt queue. Handoff and continuation replay remain explicitly queued so ownership
transfer cannot alter turn order.

## Root cause

- Grok `sendMessage` and `enqueueMessage` previously used the same `GrokTurnQueue.enqueue`
  path.
- `GrokTurnQueue.drain` returned immediately while `runtime.running` was true, so input received
  during `session/prompt` could not be consumed until the current turn completed.
- The IPC send path deferred the user event until the next turn start, which made a successfully
  accepted message appear frozen during long tool calls, permission waits, or streaming output.
- ACP v1 has no portable mid-turn prompt method. A second concurrent `session/prompt` would not be
  a safe substitute.

## Changes

### Active-turn delivery

- Added `_x.ai/interject` ACP requests with the native session id, client-generated
  `interjectionId`, text, and negotiated text/image content blocks. The underscore is required
  by ACP's extension-method wire convention; the logical Grok extension name remains
  `x.ai/interject`.
- Emit the user event immediately after the extension acknowledges `{ status: "queued" }`, with
  `steer: true` and the existing turn correlation id.
- Remember accepted idempotency keys for both queued prompts and interjections.
- Expose the adapter-level `steerTurn` operation for explicit text-only callers.

### Queue and compatibility boundaries

- Keep `enqueueMessage` and trusted continuation/handoff replay on the FIFO path.
- Detect `-32601` / “method not found” responses once per runtime and fall back to FIFO for older
  Grok versions without the extension.
- Keep image content gated by the ACP-negotiated image capability.
- Mark Grok as active-turn capable in the runtime profile and switch the SDK composer to the
  `插入` action while a turn is running.

### Runtime structure

- Extract ACP startup and background-start lifecycle into `runtime-start.ts`; `bridge.ts` is now
  481 lines instead of exceeding the repository's 500-line source guardrail.
- Update the README adapter description and add deterministic queue, extension, usage, and UI
  regression coverage.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 357 files and 3,040 tests; one file and one test remain intentionally skipped.
- The focused queue/ACP wire tests passed 11/11, including the real SDK extension-prefix path.
- `pnpm build` passed.
- `git diff --check` passed.
- Local Grok Build source confirms `x.ai/interject` is registered and drains into the active turn;
  the installed binary is `grok 0.2.110`. A no-cost initialize-only probe sent an invalid-session
  `_x.ai/interject` and received `-32602 session not found`; the bare `x.ai/interject` and an
  `ext_method` envelope both returned `-32601 method not found`, confirming the wire prefix.

The first implementation attempt used the bare logical extension name on the JSON-RPC wire. The
real-binary probe caught that protocol error before delivery; production code and the deterministic
ACP fixture now use the prefixed method and carry a regression test for it.

## Do Not Split Protection

- No production source file changed by this delivery exceeds 500 lines. The former 500-line ACP
  bridge was split before final validation; revisit the split only if the startup helper and bridge
  develop a stronger shared lifecycle abstraction.

## Related records

- `CHANGELOG_383_grok-build-adapter-profiles.md`
- `CHANGELOG_386_grok-generators-external-hooks.md`
- `REVIEW_167_grok-build-adapter-boundaries.md`
