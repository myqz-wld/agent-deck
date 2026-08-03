---
review_id: 192
reviewed_at: 2026-07-29
baseline_commit: 518168a4a22120fb286f92117b507d13d33f213f
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_192_grok-acp-silent-turn-recovery: Grok ACP silent-turn recovery

## Scope and method

Traced two UI-created Grok Build sessions from Agent Deck event storage through the ACP child and
Grok's native update log, then reproduced the application-callback failure boundary with the
deterministic fake ACP agent. Compared the UI background-start path with awaited MCP startup and
audited the bundled package version against the repository dependency declaration.

```review-scope
scripts/verify-bundled-grok.mjs
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/first-model-event-watchdog.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/first-model-event-watchdog.test.ts
src/main/adapters/grok-build/__tests__/packaging-preflight.test.ts
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A synchronous exception from Agent Deck's standard `session/update` callback escaped into the ACP SDK read loop. The connection could then stop consuming later notifications and the final prompt response without an adapter-visible error. | Catch callback failures at the ACP boundary, invoke a separately guarded diagnostic hook, and preserve consumption of subsequent notifications and responses. |
| HIGH | Grok prompt requests had no accepted-turn progress boundary. A broken notification/response path therefore left `runtime.running` true forever and exposed no recovery action. | Added a 90-second first-model-event watchdog armed before the prompt request. Echoed user/configuration events do not disarm it; real model, tool, plan, or usage activity does. Timeout emits a terminal user-visible error, disposes the ACP runtime, and never automatically replays input. |
| MEDIUM | Packaging preflight verified only that the Grok wrapper and platform package matched each other. A stale dependency tree could bundle 0.2.112 even though `package.json` required `^0.2.114`. | Validate the installed wrapper against the exact/caret/tilde stable dependency declaration before packaging, and fail with an actionable `pnpm install` instruction. |

## Evidence

- Agent Deck sessions `55453cd7-df4f-4488-af76-a6b822d28345` and
  `beb803e0-876a-476d-aa37-36eb686a68ed` contained only `session-start` and the
  user `hi`; neither had assistant, thinking, finished, or error events.
- Grok native sessions `019fb12c-e36c-7e91-ae7f-8865a1ef2415` and
  `019fb0d0-459b-72a1-a38f-1defd81160db` both recorded thought, assistant,
  `turn_completed`, and `end_turn` output.
- Direct stdout and login-shell/FD3 probes using the same Grok 0.2.112 binary completed normally,
  placing the failure inside the full application ingest boundary rather than provider inference,
  authentication, or the transport framing itself.
- The callback-failure regression throws on the first standard notification and proves the next
  assistant notification and final `end_turn` response still arrive.
- The UI-style background-start regression proves a prequeued initial turn is drained only after
  the native session ID is committed and the runtime is ready.
- Before dependency synchronization, the strengthened preflight rejected installed 0.2.112 against
  declared `^0.2.114`; after `pnpm install`, it verified the Darwin ARM64 0.2.114 package.

## Validation

- Focused Grok regression suite passed: 5 files and 38 tests.
- `pnpm verify:bundled-runtimes` passed with
  `@xai-official/grok-darwin-arm64@0.2.114`.
- `pnpm typecheck` passed.
- Full Electron-ABI suite passed: 469 files passed, one skipped; 4,008 tests passed, one skipped.
- `pnpm build` passed for main, preload, and renderer bundles.
- `pnpm dist` produced the Darwin ARM64 DMG; the packaged Electron runtime resolves both the Grok
  wrapper and platform package as 0.2.114.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.
- All changed first-party source files remain at or below the 500-line guardrail.

## Fixes landed

- Isolated standard ACP notification callbacks from the SDK reader and added payload-free failure
  diagnostics.
- Added bounded first-model-event recovery without imposing a deadline on healthy long-running
  Grok turns.
- Recycled a timed-out runtime so the next explicit user send can use the existing recovery path.
- Added deterministic callback-failure, watchdog, UI background-start, and stale-package tests.
- Synchronized the local Grok package tree from 0.2.112 to the declared 0.2.114.

## Residual risk

- The historical logs cannot identify the exact callback statement that first failed; the new
  diagnostic records the update type and exception if the boundary recurs.
- A provider that legitimately accepts a prompt yet produces no model-derived event for more than
  90 seconds will be recovered. This matches the existing Codex interactive watchdog policy and is
  preferable to an unbounded silent turn.
- Existing already-stuck runtimes belong to the currently running installed application. They are
  not repaired in place and must be closed or allowed to end when the updated application starts.

## Follow-up

Package and replace the installed application after its active Agent Deck process exits, then send
a fresh Grok Build prompt and confirm the application event stream contains assistant and finished
events.
