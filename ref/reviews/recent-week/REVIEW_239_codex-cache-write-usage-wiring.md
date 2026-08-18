---
review_id: 239
reviewed_at: 2026-08-13
baseline_commit: 3bb91334f550dbf3afe9aab2703acb9af5ed9e9a
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review rebucketing and bucket-index maintenance are mechanical records."
---

# REVIEW_239_codex-cache-write-usage-wiring

## Scope and method

This review traced GPT-5.6 cache-write accounting from the upstream Responses API completion
through Codex app-server 0.147 and Agent Deck's token-usage persistence boundary. It compared the
exact per-response notification with the cumulative thread notification, verified their causal
ordering in upstream Codex source, and retained the cumulative path for resumed or forked threads
that do not expose experimental raw events.

```review-scope
src/main/adapters/codex-cli/app-server/raw-response-usage.ts
src/main/adapters/codex-cli/app-server/raw-response-usage.test.ts
src/main/adapters/codex-cli/app-server/token-usage-translate.ts
src/main/adapters/codex-cli/app-server/translate.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Agent Deck requested experimental raw events but ignored `rawResponse/completed`, so exact per-response `cacheWriteInputTokens` had no direct persistence path. | Translate the exact usage into a response-id-keyed token row, including cache creation, and suppress only the matching cumulative echo. |
| INFO | `thread/tokenUsage/updated` already preserved `cacheWriteInputTokens`, but it is cumulative and is the only available path after resume/fork. | Keep it authoritative for context, live rate, and watermark updates, and retain it as the durable fallback whenever no matching exact event exists. |

## Validation and evidence

- Official OpenAI documentation identifies `cache_write_tokens` as a GPT-5.6 usage metric that
  applications should track.
- Codex `rust-v0.147.0` source emits `rawResponse/completed` before the corresponding token-count
  event and maps the same cache-write field into both usage representations.
- Focused validation passed 3 files / 44 tests, covering positive cache writes, stable response-id
  idempotency, exact/cumulative deduplication, replay, mismatch fail-open behavior, malformed raw
  fallback, the existing cumulative translator, and SQLite persistence.
- The final complete Electron suite passed 960 files / 6,143 tests; 2 files / 3 explicit live or
  environment cases were skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, `git diff --check`, and touched
  production-file size validation passed.

## Residual risk

- App-server exposes exact raw completion usage only for newly started threads. Resumed, forked,
  or process-recovered threads intentionally continue using the cumulative fallback.
- Deduplication requires all six exact metrics to match the cumulative delta. An upstream schema or
  aggregation change therefore fails open to the established cumulative path instead of silently
  dropping usage.

## Verdict

PASS. The cache-write field now has an exact fresh-thread path, the cumulative fallback remains
compatible, and no open CRITICAL, HIGH, MEDIUM, or LOW finding remains in scope.
