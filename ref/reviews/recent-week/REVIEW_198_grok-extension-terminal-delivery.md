---
review_id: 198
reviewed_at: 2026-07-30
baseline_commit: 1e340030629bbab11e2998f8d246427efd498d58
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_198_grok-extension-terminal-delivery: real Grok terminal delivery

## Scope and method

Diagnosed the first installed-app run after REVIEW_196 from Agent Deck's SQLite ledger, the exact
Grok 0.2.114 native session, persisted main-process logs, and the packaged application metadata.
Added deterministic regressions for the observed wire shape, then ran a temporary read-only test
through the real bundled Grok binary and current authentication. The temporary network test was
deleted after it passed.

```review-scope
src/main/adapters/grok-build/__tests__/provider-completion-recovery.test.ts
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/live-prompt-completion.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/turn-queue.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok 0.2.114 ended the real turn with `_x.ai/session/update` / `turn_completed` and `stop_reason=rate_limit`. Agent Deck consumed that notification only for usage and waited exclusively for `_x.ai/session/prompt_complete` or the prompt RPC, neither of which arrived. | Correlate the extension terminal to the one active prompt using native session, provider prompt id, and same-turn timestamp. Feed it into the live completion race, surface rate-limit text, finish the turn, abort the stranded request, and recycle the ACP child. |
| HIGH | Treating every successful extension terminal as authoritative could finish before native-history recovery when the ACP stream lost the assistant chunks but still delivered `turn_completed`; that would replace a hang with an empty successful turn. | A bare `end_turn` extension terminal is not terminal authority until live assistant text exists. Otherwise native-history recovery remains responsible for restoring the answer. |
| MEDIUM | Native-history polling waited for the first interval, depended on mutable runtime flags beyond its own active token, converted an expected missing file into an exception, and swallowed every read failure. The exact installed-session history was readable by the parser but the running app emitted no recovery diagnostic. | Poll immediately, use the recovery token as lifecycle authority, treat `ENOENT` as an incomplete turn, and persist the first unexpected read failure. |
| LOW | Second-precision extension timestamps can round down below a turn started later in the same second. | Permit only the sub-second rounding window when the precise `agentTimestampMs` field is absent; precise timestamps keep strict ordering. |

## Evidence

- Installed Agent Deck session `1f140b5f-4bae-4178-98a1-5df7dea90552` contained only
  `session-start` and user `hi`, and remained `working`.
- Its native Grok session `019fb234-a509-74c0-92df-10a9156114b4` ended about four seconds later
  with `_x.ai/session/update`, `turn_completed`, provider prompt
  `e565202f-51c3-4e86-9e6c-390248502b60`, and `stop_reason=rate_limit`.
- A direct parser regression against that exact file recovered the provider prompt and rate-limit
  terminal, proving the durable data was present and readable.
- A temporary real-binary integration run created Grok session
  `019fb245-23a5-76c2-847d-5ba531d028b5`. Grok again returned the actual 429 extension-terminal
  sequence, and the fixed queue produced a visible message plus `finished` in 6.5 seconds instead
  of remaining `working`.

## Validation

- Focused Grok adapter suite passed: 25 files and 158 tests; the final changed-path regression set
  passed 27 tests.
- Final full Electron-ABI suite passed: 475 files and 4,045 tests; one file and one test skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm verify:bundled-runtimes`, and
  `bash scripts/logger-check.sh` passed.
- `bash scripts/file-level-review-expiry.sh` ran successfully.
- A clean `pnpm dist` completed at `2026-07-30T09:07:44.002Z`. The
  365,888,102-byte DMG passed `hdiutil verify`; SHA-256 is
  `31168765518214203e4895cbba710e454d415f6358347b357f03df41914c3dc6`.
- The unpacked packaged app was ad-hoc re-signed and passed strict deep signature verification.
  Its bundled main process contains both the live extension-terminal guard and the native-history
  read diagnostic.
- Every changed first-party source file remains at or below 500 lines.

## Residual risk

- The local Grok account is currently over its rolling free quota, so the real-binary verification
  exercised the exact rate-limit terminal rather than a fresh successful model response. Successful
  answer delivery is covered by ordered live-assistant tests and native-history recovery tests.
- Native-history recovery still depends on Grok's current on-disk session layout. Unexpected read
  failures are now visible in persisted logs instead of being silently ignored.
