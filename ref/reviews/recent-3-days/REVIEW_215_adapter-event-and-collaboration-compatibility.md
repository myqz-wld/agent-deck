---
review_id: 215
reviewed_at: 2026-08-05
baseline_commit: 1f5d6898dc1714e4461e6ecdf10fb13f7f66da31
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review, changelog, rebucketing, and bucket-index maintenance are mechanical records."
---

# REVIEW_215_adapter-event-and-collaboration-compatibility: Current adapter event contracts

## Scope and method

This audit compared the installed dependency schemas, exact Codex 0.146 source tag, normalized
Agent Deck events, persisted session activity, renderer contracts, and all three adapter
translators. It specifically reproduced the missing Codex native-agent rows and inspected why a
parent turn can finish while native children remain active. Neither `simple-review` nor
`deep-review` was invoked.

```review-scope
package.json
pnpm-lock.yaml
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
resources/grok-config/GROK_AGENTS.md
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-init-runtime-model.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-tool-result.test.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.test.ts
src/main/adapters/codex-cli/app-server/first-model-event-watchdog.ts
src/main/adapters/codex-cli/app-server/translate-collab.test.ts
src/main/adapters/codex-cli/app-server/translate-collab.ts
src/main/adapters/codex-cli/app-server/translate-display-items.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/renderer/components/activity-feed/rows/tool-row.test.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The normalized Codex translator recognized `collabToolCall`, but the installed 0.146 schema emits `collabAgentToolCall` with plural receivers and camel-case operations. Native collaboration therefore produced no shared `Agent` row in the session page. | Added current-shape start/end translation, operation normalization, child state/failure preservation, `subAgentActivity` coverage, raw-call fidelity, and renderer assertions. Retained the older shape only as a bounded external-binary fallback. |
| MEDIUM | Codex native child completion uses `trigger_turn: false`: it reaches the parent's native mailbox but does not start a new parent turn. A lead could answer after spawning without checking or consuming a required child. | Added a Codex-native completion boundary requiring useful lead work followed by `list_agents` / `wait_agent`, consumption of every required result, and explicit interruption of abandoned children before final output. Agent Deck does not synthesize a hidden provider turn. |
| MEDIUM | Current Codex display items and result metadata were partly dropped: web results, sleep/image rows, command/MCP/dynamic durations, and the structured MCP result envelope were incomplete; new item types also did not satisfy the continuation watchdog. | Added display-item translation, duration and structured-result preservation, base64-safe image summaries, and watchdog coverage. |
| MEDIUM | Claude could flatten the SDK's top-level structured result to the textual content block and did not update the displayed runtime model after a non-local refusal fallback. Non-array content could also enter the loop through loose runtime input. | Preserve `tool_use_result` for exactly one result block, synchronize the non-local fallback model, and guard assistant/user content with `Array.isArray`. |
| LOW | The concise Claude resource draft initially implied internal one-shot sessions also receive the interactive Agent Deck baseline. The actual summarizer and usage probes use `settingSources: []` with caller-owned minimal options. | Limited the baseline claim to interactive sessions and explicitly documented that isolated one-shots load neither the normal instruction chain nor this baseline. |
| INFO | Grok ACP 1.3 already covers its current `tool_call`, `tool_call_update`, `_meta` status, extension-terminal, and prompt-complete variants. | Added no speculative fallback or source change; existing Grok suites remained green. |

No confirmed finding remains open.

## Corrected historical fact

The Codex collaboration conclusion in `REVIEW_204_compatibility-cleanup.md` is superseded. Its
statement that Codex 0.146 emits `collabToolCall` was inverted: the exact installed schema and
0.146 source define `collabAgentToolCall`; `collabToolCall` is retained only as a compatibility
input for an older or custom externally selected binary. The historical record remains unchanged.

## Parent-turn completion boundary

The reported turn end is not an Agent Deck interruption. Persisted parent activity ended normally
as `task_complete` while child threads continued. Codex forwards child completion to the parent
with `trigger_turn: false`, so the result becomes actionable when the parent is still waiting or on
a later parent turn. The fix is therefore two-layered:

- the event bridge makes native collaboration visible in the session transcript; and
- the Codex runtime contract requires the lead to inspect/wait and consume all required children
  before declaring the request complete.

Starting an app-generated hidden turn would bypass native provider lifecycle and user turn
semantics, so this change deliberately does not fabricate one.

## Validation and evidence

- Exact dependency schemas and the Codex 0.146 source tag were inspected before implementation.
- Focused suites passed 106 translator, watchdog, Claude-result, and renderer tests during
  iteration; prompt-lock regressions were corrected without weakening their assertions.
- Full Electron-ABI testing passed 471 files and 3,877 tests; one credentialed live smoke remained
  intentionally skipped.
- Typecheck, production build, logger validation, bundled-runtime verification, review-expiry
  inventory, prompt hash checks, and whitespace validation passed.
- Renderer component coverage proves the session feed renders native `Agent` start, completion,
  activity, target/runtime metadata, wait timeout, raw input, output, and failure states from the
  normalized events.

## Residual risk

- The installed Agent Deck process owns this active session and was not restarted or overwritten.
  Its main process still runs the previous translator until the next normal rebuild/install and
  restart.
- Agent Deck's session-private in-app Browser opens separate hardened tabs without the main
  Electron preload, so it cannot attach to or hot-replace the installed application's primary
  session window. Live source-to-installed-window smoke coverage is therefore deferred to that
  restart; translation and renderer behavior are covered at their exact component boundaries.
- External Codex binaries may expose another future collaboration variant. Unknown items remain
  visible in raw diagnostics, and the current/fallback fixtures make schema drift localized.

## Final verdict

ACCEPT. Current Codex native collaboration now reaches the shared session UI, required native
children have an explicit collection boundary, Claude preserves structured result/model state,
and the Grok path remains aligned without speculative changes.

## Related records

- `CHANGELOG_434_adapter-runtime-event-fidelity.md`
