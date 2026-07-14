---
review_id: 147
reviewed_at: 2026-07-10
baseline_commit: ababbfc
expired: false
skipped_expired: []
---

# REVIEW_147_codex-collaboration-raw-events: Codex collaboration raw-event boundary

## Scope

This debug review traces missing Codex collaboration tool calls from the native rollout through
Codex 0.144 app-server notification gating, Agent Deck translation, event merging, and SQLite
persistence, then records the focused fresh-thread fix.

```review-scope
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/codex-cli/app-server/client.test.ts
```

## Gate Result

PASS for newly started Codex threads.

Severity distribution:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 1 fixed
- Residual upstream limitation: cold resume/fork raw-event opt-in is unavailable

## Finding

### MEDIUM fixed: Agent Deck parsed only normalized `wait_agent` collaboration items

The native rollout for session `019f4ac1-731c-7463-a152-60496bc90edb` contains four
`spawn_agent`, four `send_message`, five `list_agents`, two `followup_task`, and nine
`wait_agent` calls. SQLite contained only the nine wait start/end pairs. Representative missing
call `call_qxdJfvIQUhu1ZI4ytIS2wISK` was a native `spawn_agent`; retained call
`call_zBQVRMuU9XynFlI7y4W8gdux` was `wait_agent`.

The first disappearance boundary is Codex app-server, before Agent Deck receives JSON-RPC stdout:

- Codex 0.144 requires the per-thread `thread/start.experimentalRawEvents` opt-in to deliver raw
  Responses API items.
- Its thread listener drops every `RawResponseItem` with `continue` while that flag is false.
- Agent Deck negotiated `initialize.capabilities.experimentalApi: true`, which permits experimental
  fields, but omitted the separate thread opt-in.
- MultiAgentV2 emits normalized `collabAgentToolCall` lifecycle items for `wait_agent` but not for
  the other observed operations. Their complete call identity and arguments exist only in raw
  response items.

Exact upstream evidence is in Codex tag `rust-v0.144.0`, commit `7678224`: the
[thread-start opt-in](https://github.com/openai/codex/blob/767822446c7a594caa19609ca435281a9ec67e0d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L143-L147),
[listener filter](https://github.com/openai/codex/blob/767822446c7a594caa19609ca435281a9ec67e0d/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L311-L320),
and [normalized wait lifecycle](https://github.com/openai/codex/blob/767822446c7a594caa19609ca435281a9ec67e0d/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L77-L113).

## Downstream Exclusion

- Agent Deck dispatches every method-bearing app-server notification and forwards every yielded
  notification to `translateCodexAppServerNotification`.
- Raw collaboration translation preserves the provider call ID and emits start/end events without
  filtering the observed tool names.
- Session ingestion does not tool-name-filter SDK events.
- SQLite deduplicates by `(session_id, kind, tool_use_id)`. The missing spawn call ID cannot collide
  with or be rewritten into the retained wait call ID.
- Retained wait payloads lacked raw `timeout_ms`, positively proving they came only from normalized
  items. Existing merge coverage proves a raw timeout would have survived a later normalized merge.

## Live Metadata-Only Evidence

A temporary Codex 0.144 app-server harness used ephemeral threads and logged only method, item type,
call ID, function name, and argument keys:

- `experimentalRawEvents: true`: nine `rawResponseItem/completed` notifications, including one
  `collaboration.list_agents` call and its matching output; no normalized
  `collabAgentToolCall` existed for that operation.
- Flag omitted/false: zero raw-response notifications; only normalized user, reasoning, and agent
  message items were delivered.

This A/B result matches the source-level unconditional listener filter.

## Fixes Landed

- Added `experimentalRawEvents: true` to fresh `thread/start` request construction.
- Added a regression assertion at the disappearance boundary.
- Kept `thread/resume` and `thread/fork` request shapes unchanged because Codex 0.144 does not
  define the field for those methods.
- Left `normalizeCollabToolName` unchanged; it was not involved.

## Validation

- Focused app-server request and collaboration translation tests: 2 files / 14 tests passed.
- `pnpm typecheck`
- `pnpm test` — 205 files / 2244 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`

## Residual Risk

- Codex 0.144.0, 0.144.1, and current upstream main expose `experimentalRawEvents` only on
  `thread/start`; cold `thread/resume` and `thread/fork` listener attachment hardcode raw events off.
  Complete collaboration visibility can therefore disappear after an app-server process restart or
  cold resume. Addressing that requires an upstream protocol addition or a separately designed local
  history fallback, not a safe extension of this focused fix.
- The installed Agent Deck application was not overwritten or restarted because it hosts this active
  session. The source build is validated; installed interactive verification requires a later rebuild
  and restart.
- Raw response notifications are experimental provider API and require revalidation when Codex is
  upgraded.

## Related Records

- [PLAN_3](../../plans/recent-week/PLAN_3_codex-collaboration-raw-events.md)
- [CHANGELOG_350](../../changelogs/recent-week/CHANGELOG_350_codex-collaboration-observability.md)
