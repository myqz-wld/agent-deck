---
review_id: 296
reviewed_at: 2026-09-29
baseline_commit: 679a75866db56eb01ab2dafa7b9a5e7f2685d902
expired: false
---

# Session output and Gateway thinking corrections

## Scope

Implement the user's approved follow-up to the Claude, Grok, and Codex screenshot investigation.
This record documents direct source inspection and regression validation, not a paired review.
The user explicitly excluded thinking-source labels. No private provider configuration was edited.

```review-scope
README.md
src/shared/claude-config.ts
src/shared/claude-config.test.ts
src/main/adapters/session-creation-defaults-core.ts
src/main/adapters/session-creation-defaults-core.test.ts
src/hosts/provider-state/provider-session-projection.ts
src/hosts/provider-state/provider-session-projection.test.ts
src/renderer/hooks/useLastSessionDefaults.ts
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/hooks/__tests__/useLastSessionDefaults.test.ts
src/renderer/hooks/__tests__/gateway-thinking.test.tsx
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/components/activity-feed/tool-result-presentation.ts
src/renderer/components/activity-feed/output-presentation.test.tsx
src/renderer/components/activity-feed/rows/tool-result.tsx
src/renderer/components/activity-feed/rows/simple-row.tsx
src/renderer/components/activity-feed/tool-status.ts
src/renderer/components/activity-feed/message-display-presentation.ts
src/renderer/components/activity-feed/message-display-presentation.test.tsx
src/renderer/components/activity-feed/records-view.tsx
```

## Findings and fixes

| Finding | Normal trigger and consequence | Resolution |
|---|---|---|
| MEDIUM: environment effort omitted | A selected Claude Gateway provides `env.CLAUDE_CODE_EFFORT_LEVEL: max` without a top-level effort. The form resolves high and submits that value. | Share settings/environment parsing across Desktop and Remote; test the displayed choice and submitted creation request. |
| MEDIUM: thinking crosses Gateway boundaries | Select a manual level, then switch Gateway within the same adapter. The previous override shadows the new defaults. | Store Desktop thinking per adapter/Gateway and scope Remote overrides to their source, authoring cycle, adapter, and Gateway. |
| MEDIUM: result wrappers obscure output | Read/Bash objects and MCP envelopes appear as JSON with escaped newlines. | Render known text bodies and separate shell streams, with complete raw inspection and unknown-structure fallback. |
| LOW: duplicate external messages | MessageDisplay flushes and Stop report the same reply. | Project related flushes into one bubble and reconcile the final reply within a correlated prompt/turn. |
| LOW: empty details and rounded durations | Empty task arrays create labels with no values; positive sub-millisecond durations round to zero. | Filter empty metadata and distinguish positive sub-millisecond duration from actual zero. |

Claude's documented [effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level)
places explicit environment effort ahead of settings effort. The installed SDK's MessageDisplay
type defines a stable message id, increasing delta index, prompt/turn identifiers, and a possibly
empty final flush. The implementation follows those fields rather than globally deduplicating text.

## Validation and evidence

- The original environment-only fixture resolved high; it now resolves max. Top-level settings,
  layer precedence, invalid/missing values, and automatic effort are covered separately.
- Gateway tests cover native/default isolation, returning to a previous Gateway, manual edits while
  configuration is pending, Remote capability refresh, and the submitted thinking value.
- Presentation tests cover Claude and Grok aliases, stdout/stderr, separate errors and exit codes,
  MCP text and structured-only results, images, unknown structures, raw inspection, and live output.
- Display-message tests cover duplicate delta delivery, empty final flushes, stable bubble identity,
  legacy user-turn boundaries, different prompts/sessions/subagents, and distinct identical replies.
- Final `pnpm typecheck`, `pnpm test`, and `pnpm build` passed. The full suite passed 1,078 files and
  6,663 tests, with two files and three tests skipped. SQLite binding bytes remained unchanged.
- A background Session Browser tab loaded a disposable, production-built fixture of the actual
  components. Snapshots confirmed HIGH to MAX after selecting DeepSeek and raw-data expansion.
  Inspected screenshots covered the Gateway form, Read/Bash/MCP output, and the deduplicated external
  conversation. The fixture supplied synthetic data; it did not create a live provider session.
- The Browser tab was closed after verification. Temporary preview files were removed.
- Review-expiry mapping was run; prior records did not exempt changed files. Record buckets were
  scanned, with no pre-existing moves required. The archive reminder hook remains installed.

## Residual risk and activation

Historical events without correlating ids or a loaded user-turn boundary remain separate when a
safe match cannot be established. Persisted events are unchanged. Unknown output schemas remain
inspectable as JSON. Provider model limits can still determine the actual runtime effort.

Every changed source file is below 500 lines. No host process was stopped or restarted, and no
installed bundle was replaced. Main-process changes require activation in a rebuilt runtime; the
existing installed application does not acquire these source changes automatically.

See [CHANGELOG_655](../../changelogs/recent-3-days/CHANGELOG_655_session-output-gateway-thinking.md).
