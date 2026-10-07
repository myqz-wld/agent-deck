---
review_id: 306
reviewed_at: 2026-09-30
baseline_commit: 8a9e93a0baf02d89c085f8e9511f3de577dbae58
expired: false
---

# Recover Gateway switching after a failed Codex turn

## Scope and method

Follow up on REVIEW_279 after the user reported that Gateway selection works for new sessions
but fails after an existing session reports a connection error. The UI could remain on
`Codex 正在重连...`. Investigation used source tracing, failing regressions, and isolated native
Codex 0.159.2 processes with synthetic loopback Responses endpoints. No paired review was requested.

```review-scope
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/app-server/thread-gateway-refresh.test.ts
src/main/adapters/codex-cli/app-server/thread-gateway-native.test.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/adapters/codex-cli/app-server/translate-diagnostics.test.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/stream-finalize-core.ts
src/main/adapters/grok-build/runtime-mutation-controller.ts
```

## Findings and repairs

| Severity | Finding | Repair |
|---|---|---|
| HIGH | After a terminal stream error, native Codex can report successful unsubscribe while retaining the loaded thread. Resume then rejoins its old configuration. The previous repair and fixture assumed successful unsubscribe meant the thread was unloaded. | Drain the failed turn through the existing bounded interrupt/completion fence, then retire its resumable client generation. The next input resumes the same native thread from history using the selected Gateway. |
| MEDIUM | The translator let connection-related wording override native `willRetry: false`, showing reconnection without publishing the terminal failure. | Treat an explicit native retry flag as authoritative. Terminal disconnections publish the error and finish the turn. |
| LOW | The reconnect message still contained a decorative emoji in main-process generated text. | Remove the emoji from newly generated reconnect messages. |

Successful turns and ordinary Gateway switching retain the existing behavior. Shared ephemeral
summary/compaction clients are excluded from the new post-error generation retirement after
their native completion drains. Existing cancellation, watchdog, generation fencing, session
identity, model/thinking, and permission controls remain in use.

The public run-options type moved to the protocol module and is re-exported from its original
module. All changed source/test files remain at or below 500 lines.

## Reproduction and validation

- Before the repair, an actual native turn failed against the old endpoint, then a Gateway
  switch still sent the next request to that endpoint. `thread/loaded/list` confirmed that the
  failed thread remained loaded after successful unsubscribe, including after native completion.
- Two new regressions failed before the repair: stale request routing and terminal disconnection
  incorrectly displayed as reconnection.
- Native acceptance now covers HTTP 401, HTTP 503, and a truncated SSE stream. Each case first
  completes one old-Gateway turn, fails the next turn, switches to a different provider, switches
  to another endpoint with the same provider id, then restores native defaults. All actual request
  destinations, the native thread id, and preceding user/assistant history are checked.
- The native fixture uses fresh provider homes and synthetic local endpoints without user
  credentials. It is retained as an opt-in test rather than a disposable acceptance script:

  ```sh
  AGENT_DECK_CODEX_GATEWAY_TEST_BINARY="$CODEX_TEST_BINARY" pnpm test src/main/adapters/codex-cli/app-server/thread-gateway-native.test.ts
  ```

- Unit coverage includes both collected and streamed output, missing native completion with
  bounded cleanup, a Gateway selected during cleanup, shared ephemeral clients, and healthy
  switches without generation retirement.
- Focused Codex, Claude, Grok, and local/remote runtime-control coverage passed. Claude uses
  query closure/recovery and releases failed stream ownership; Grok has no separate Gateway
  selector and requires native model acknowledgement. No equivalent defect was found in those
  inspected paths; external native Claude/Grok sessions were not exercised.
- `pnpm typecheck` and `pnpm build` passed. Full `pnpm test`, with the native Gateway test enabled,
  passed 1,117 files / 6,900 tests; two files and three pre-existing opt-in tests stayed skipped.
- The Electron test runner left the SQLite native binding checksum unchanged. Whitespace and
  identifying-path/token checks passed.
- The review-expiry script was attempted but exited unsuccessfully. Changed paths were checked
  manually against their latest available coverage, Git history, and
  churn; all changed files were inspected without relying on earlier review exemptions.

## Residual risk and activation

The failing computer's installed build was not directly inspected. Native acceptance verifies
current source against Codex 0.159.2, including the user's error-then-switch scenario. Other native
versions can rerun the retained test with their binary.

The affected computer needs an installation containing this main-process repair and an application
restart. No user-owned running app, provider session, or installed bundle was stopped or replaced.
Historical persisted message bodies retain their original text.

Related plan: [Failed Gateway recovery](../../plans/recent-week/PLAN_75_codex-failed-gateway-recovery.md).
Previous repair: [Loaded-thread Gateway switching](../recent-month/REVIEW_279_codex-live-gateway-switch.md).
