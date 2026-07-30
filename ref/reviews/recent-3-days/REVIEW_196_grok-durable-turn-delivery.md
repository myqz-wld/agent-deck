---
review_id: 196
reviewed_at: 2026-07-30
baseline_commit: 2818e18d1d78f6f2ad18f7f167adf952fc84ff82
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_196_grok-durable-turn-delivery: durable Grok turn delivery

## Scope and method

Traced the latest installed-app silent Grok turn through Agent Deck's SQLite event ledger, Grok
0.2.114 native history, the live ACP method set, and the current recovery/lifecycle code. Replayed
both extension wire method variants with the deterministic ACP child and reproduced the exact
provider-completed/application-pending state with a permanently unresolved prompt request plus a
matching native `turn_completed` record.

```review-scope
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs
src/main/adapters/grok-build/__tests__/transport-recovery.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/history-usage.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/translation-types.ts
src/main/adapters/grok-build/transport-recovery.ts
src/main/adapters/grok-build/turn-queue-types.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/turn-response.ts
src/main/adapters/grok-build/usage-translate.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok completed inference and durably wrote thought, assistant text, exact usage, and `turn_completed`, while Agent Deck received no model update, prompt-complete terminal, or final prompt response. The live-terminal repair cannot recover when the whole post-prompt ACP rail disappears. | Race live ACP against the exact native session's durable terminal. Recovery requires the active local turn boundary, matching native session, provider prompt id, and a completion timestamp at or after turn start. It never replays the prompt. |
| HIGH | Grok 0.2.114 exposes both `x.ai/session/update` and `x.ai/session_notification`, while Agent Deck and its fake ACP fixture covered only `_x.ai/session/update`. This let deterministic tests pass without exercising the second real wire route. | Register and parse both underscored wire methods, use the same predicate in historical usage parsing, and exercise both variants through the ACP process test. |
| MEDIUM | A transport can fail after only part of an assistant message reaches Agent Deck. Restoring the complete native text naively would either duplicate the observed prefix or omit the missing suffix. | Track all live assistant text for the active turn and append only the missing native-history suffix, with overlap recovery for non-prefix partial delivery. |
| MEDIUM | Closing the runtime after native-history recovery discards queued messages and forces application-level recovery. Reusing the suspect child risks another silent turn. | Suppress late updates, abort the stranded request, stop only the failed ACP child, load the same native session in a fresh child, and preserve the application session, FIFO, MCP ownership, model/mode, and sandbox settings. |

## Evidence

- Agent Deck session `23985e81-792a-4ace-842a-44bf60323a49` stored only session start and user
  `hi`. Native Grok session `019fb1ff-657b-7971-afde-6c7ca574aa45` completed in about four seconds
  with `Hi — what would you like to work on?`, reasoning, exact usage, and `end_turn`.
- A local read-only regression against that exact native history passed and reconstructed the
  assistant text and `end_turn` through `readCompletedGrokNativeTurn`.
- The bundled Grok 0.2.114 binary contains both `x.ai/session_notification` and
  `x.ai/session/update` protocol routes.
- The silent-rail regression leaves `session/prompt` pending forever, writes a matching native
  assistant and terminal, verifies message/usage/finished delivery, verifies request abort, and
  verifies transport recycling without closing the application session.

## Validation

- All focused Grok adapter tests passed: 24 files and 154 tests.
- Full Electron-ABI suite passed: 474 files and 4,039 tests; one file and one test skipped.
- `pnpm typecheck` passed.
- `pnpm verify:bundled-runtimes` verified
  `@xai-official/grok-darwin-arm64@0.2.114`.
- `pnpm build` passed for main, preload, and renderer bundles.
- `pnpm dist` produced the Darwin ARM64 app and DMG with dirty build metadata at
  `2026-07-30T08:28:11.438Z`.
- The 365,884,639-byte DMG passed `hdiutil verify`; SHA-256 is
  `4535d4fb4367ce22b48156a9a3793ba05427cb92fc09e216c505bb55ed3b0396`.
- With no Developer ID installed, the unpacked packaged app was ad-hoc re-signed and passed strict
  deep signature verification.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.
- Every changed first-party source file remains at or below the 500-line guardrail.

## Fixes landed

- Added dual live registration for Grok's extension update and session-notification wire methods.
- Restored native history only as a same-turn terminal safety rail when live ACP does not settle.
- Restored missing assistant text and exact usage without replaying the user's prompt.
- Added partial-text suffix deduplication.
- Recycled only the failed ACP transport while preserving the live application runtime and FIFO.
- Added provider-completed/live-stalled, dual-method, success-recycle, and failed-recycle tests.

## Residual risk

- Native-history recovery depends on Grok's versioned
  `~/.grok/sessions/<encoded-cwd>/<native-session-id>/updates.jsonl` layout. It is inactive when
  live ACP settles normally and is intentionally a final safety rail, not the primary transport.
- Text replies and exact usage are reconstructed. If a future Grok turn returns only an image and
  the entire live ACP stream disappears, Agent Deck can finish the turn but cannot reconstruct the
  image from the current native-history parser.
- A fresh provider call was not issued after the repair because the local Grok free quota was
  already rate-limited during diagnosis. The exact failed native record and deterministic
  packaged-protocol shapes were both validated locally.

## Follow-up

After the current Agent Deck process exits and the Grok rolling quota is available,
overwrite-install `build/dist/mac-arm64/Agent Deck.app` and confirm a fresh prompt produces
assistant and finished events without a `grok_provider_completion_recovery` diagnostic.
