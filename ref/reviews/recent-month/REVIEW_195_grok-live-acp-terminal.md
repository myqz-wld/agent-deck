---
review_id: 195
reviewed_at: 2026-07-29
baseline_commit: e21d9295f8de08226fa9fbdad75b45df52720f48
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_195_grok-live-acp-terminal: Grok live ACP completion delivery

## Scope and method

Traced the still-silent installed-app turn through Agent Deck's event ledger, the matching Grok
native session, Grok Build 0.2.114 source, the ACP TypeScript SDK, and a real Grok process using
Agent Deck's complete sandbox, MCP, rules, plugin, model, and reasoning configuration. Replaced the
native-session journal delivery path introduced by REVIEW_192/193 with Grok's live ACP terminal.

```review-scope
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/live-prompt-completion.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/turn-queue-types.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/turn-response.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok 0.2.114 emits the official extension notification `_x.ai/session/prompt_complete` after all model updates and before constructing the final `session/prompt` response. Agent Deck did not register this notification, so a lost final response left the already-received assistant chunks buffered forever. | Registered and parsed the live terminal, routed it through runtime ownership checks, and made it complete and flush the active turn. |
| HIGH | The previous repair polled `~/.grok/sessions/**/updates.jsonl` for message text, treated the journal as a completion race, and closed the session after recovery. That bypassed the live ACP rail and made normal delivery dependent on provider filesystem layout. | Removed `provider-completion-recovery.ts` and all journal-based message-delivery behavior. Standard `PromptResponse` and live `prompt_complete` are now the only active-turn completion rails. |
| MEDIUM | A fire-and-forget terminal can arrive late from an older turn. Session id alone cannot prevent that terminal from completing a newer in-flight prompt. | Every prompt now sends a client-minted numeric `_meta.turnId`; Grok echoes it in `prompt_complete`, and Agent Deck requires an exact session + turn match. |
| MEDIUM | Grok's exact live usage is present in `PromptResponse._meta.usage`, not necessarily the standard top-level `usage`. The prior repair read the journal to obtain the same dimensions. | Added a 250 ms response grace after the live terminal and translates exact prompt metadata through the existing per-turn Grok usage path. Message delivery does not wait beyond that bounded grace. |

## Evidence

- Installed Agent Deck session `1f0dcec2-1e71-4e2a-b542-043bc92062c0` stored the user `hi` but
  no assistant/finished event. Its native Grok session
  `019fb1ac-c29a-7110-866e-e13fcfd3c4a5` completed in about four seconds with assistant text and
  `turn_completed`.
- Grok Build source at official repository commit `500129c` constructs
  `x.ai/session/prompt_complete` in
  `crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`, including the prompt id,
  stop reason, optional error result, and the caller-provided numeric `turnId`.
- The Rust ACP schema adds the required underscore to extension methods on the JSON-RPC wire, so
  the TypeScript client route is `_x.ai/session/prompt_complete`.
- A real bundled Grok 0.2.114 probe with sandbox + MCP + rules + plugin returned `ACP_OK`, emitted
  assistant chunks, emitted a prompt-complete terminal with `turnId: 91`, and returned exact
  input/output/reasoning/cache-read usage in `PromptResponse._meta`.
- The lost-response regression holds the `PromptResponse` forever, buffers a standard ACP
  assistant chunk, sends the matching prompt-complete terminal, and verifies that Agent Deck emits
  the assistant and exactly one finished event without closing the session.

## Validation

- Real bundled Grok 0.2.114 ACP probe passed with the full Agent Deck configuration.
- Focused ACP process, runtime routing, turn queue, and translation tests passed.
- `pnpm typecheck` passed.
- Full Electron-ABI suite passed: 471 files and 4,020 tests passed; one file and one test skipped.
- `pnpm build` passed for main, preload, and renderer bundles.
- `pnpm dist` verified bundled Grok 0.2.114 and produced the Darwin ARM64 app and DMG with dirty
  build metadata at `2026-07-30T07:10:17.050Z`.
- The 365,886,062-byte DMG passed `hdiutil verify`; SHA-256 is
  `d46ac693cc8c1df0f84296748594d08e788ed31a0c88ceea903f8e5309478e7d`.
- With no Developer ID installed, the unpacked packaged app was ad-hoc re-signed and passed strict
  deep signature verification.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.
- Every changed first-party source file is at or below the 500-line guardrail.

## Fixes landed

- Connected Grok's live prompt-complete ACP notification from the process router through the
  runtime bridge to the active turn queue.
- Added exact, provider-echoed turn correlation and rejected stale/mismatched terminals.
- Flushed buffered ACP assistant/thinking content and finished the turn when the final response is
  lost, without replaying the prompt or closing the session.
- Kept the standard prompt response as the compatibility completion rail and imported its exact
  Grok metadata usage when available.
- Removed native journal polling and journal-restored messages from active delivery.
- Cleared stale update suppression after both new and loaded runtime startup paths.

## Residual risk

- Grok versions without `prompt_complete` continue to depend on the standard `PromptResponse`, as
  required by ACP. The bundled and real-tested 0.2.114 version exposes the live terminal.
- If the entire ACP stream disappears after model activity, both assistant chunks and the live
  terminal can be lost together. Process-exit handling still owns that transport-failure case.
- If `PromptResponse` arrives more than 250 ms after the live terminal, the message still completes
  immediately, but that turn's exact usage may appear later through the existing historical usage
  importer.
- The currently running installed app cannot adopt main-process changes in place. It must exit
  before the packaged app can replace `/Applications/Agent Deck.app`.

## Follow-up

After this Agent Deck process exits, replace the installed app with
`build/dist/mac-arm64/Agent Deck.app`, ad-hoc sign it, clear quarantine, relaunch, and confirm that a
new Grok prompt writes its assistant and finished events without any native-journal recovery marker.
