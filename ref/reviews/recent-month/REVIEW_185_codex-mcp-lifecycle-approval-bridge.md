---
review_id: 185
reviewed_at: 2026-07-27
baseline_commit: 81da7b3d626ee66adaf8361dc70141bf8f31be2c
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record and bucket-index maintenance are mechanical archive work."
---

# REVIEW_185_codex-mcp-lifecycle-approval-bridge: Codex MCP lifecycle approvals

## Scope and method

The investigation correlated Agent Deck's SQLite session events with the native Codex rollout for
the same session, then traced app-server server-request handling into the existing Agent Deck
permission queue. The installed Codex `0.145.0` TypeScript schema and its tagged Rust implementation
were used as the wire-protocol authority.

```review-scope
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/permission-controller.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/permission-controller.test.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | `shutdown_session` and `hand_off_session` truthfully advertise destructive lifecycle effects, so Codex requests explicit MCP tool approval. Agent Deck handled command, file-change, and permission-grant server requests, but returned the generic JSON-RPC fallback for both MCP approval transports: `item/tool/requestUserInput` and `mcpServer/elicitation/request`. Codex then normalized the missing host answer to `user rejected MCP tool call` before the MCP handler ran, with no Pending card for the user to approve. | Recognize only protocol-authenticated MCP approval shapes, route them through the existing permission queue, and translate allow-once, allow-for-session, decline, cancel, abort, and timeout back into Codex's exact response vocabulary. Generic user questions and unrelated MCP elicitations remain unhandled. |

## Evidence and validation

- Agent Deck's database recorded the three failures at `2026-07-27 21:12:02`, `21:41:05`, and
  `21:41:28`. The paired Codex rollout events completed in 37 ms, 25 ms, and 37 ms respectively,
  with no approval request or `waiting-for-user` event between tool start and failure.
- Read-only MCP operations in the same session completed normally, ruling out session identity,
  transport authentication, and MCP server availability.
- The Codex `rust-v0.145.0` source defines the compatibility question-id prefix and answer labels,
  plus the structured elicitation metadata and response semantics:
  <https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/core/src/mcp_tool_call.rs>.
- The app-server protocol requires host clients to answer server-initiated approval requests:
  <https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md>.
- Focused regression coverage passed 2 files and 12 tests, including both MCP transports and exact
  allow-once, session-persist, decline, and cancellation responses.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
- The final full Electron-ABI suite passed 399 files and 3,344 tests; one credentialed live smoke
  test remained skipped.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.

## Fixes landed

- MCP approval compatibility questions now become normal Agent Deck Pending permission rows.
- Feature-gated structured MCP elicitations use the same queue and preserve session-scoped approval.
- A visible deny maps to Codex's dedicated synthetic decline token; transport cancellation and
  cleared requests remain distinct cancellations.
- Strict shape guards prevent generic `requestUserInput` questions or ordinary MCP elicitations
  from being mistaken for tool approval.
- Changed production and test files remain below 500 lines.

## Residual risk

- The currently running installed Agent Deck process does not contain the rebuilt main-process
  code. End-to-end confirmation therefore requires restarting or reinstalling the rebuilt app,
  which would terminate this diagnostic session.
- The permission UI intentionally exposes session persistence but not Codex's optional permanent
  config mutation. Users can approve once or for the current session without silently changing
  long-lived MCP policy.

## Follow-ups

After restarting the rebuilt app, invoke `shutdown_session` on a disposable child session. Confirm
that a Pending approval row appears, choose Allow, and verify that the child closes. Then invoke
`hand_off_session`, approve it, and confirm that ownership transfers only after the approval.
