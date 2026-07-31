---
review_id: 207
reviewed_at: 2026-07-31
baseline_commit: 765f2c9f0bbf38df1e2ca228c01af41e8b35201d
expired: false
---

# REVIEW_207_exit-worktree-output-schema-compatibility: MCP Zod output validation

## Scope and method

Traced the reported `Cannot read properties of undefined (reading '_zod')` failure from the
`exit_worktree` registration through the pinned MCP SDK's output-schema normalization and
post-handler validation. The review used the real SDK server/client pair rather than treating a
direct `safeParse` as sufficient evidence.

```review-scope
src/main/agent-deck-mcp/server.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/agent-deck-mcp/__tests__/worktree-contract-drift.test.ts
```

## Finding and disposition

| Severity | Root cause | Disposition |
|---|---|---|
| MEDIUM | `exit_worktree` registered a top-level Zod discriminated union as MCP `outputSchema`. The SDK accepts only schemas normalizable to one object, normalized the union to `undefined`, and then dereferenced `undefined._zod` while validating an otherwise successful handler result. | Fixed with one strict object schema plus cross-field refinements and a real registration/call regression. |

The handler had already durably armed `exit_waiting_tool_result` before validation failed. The
failure therefore blocked delivery of the exact success result and automatic cwd restoration, but
did not delete the worktree or lose its lease.

## Fixes landed

- Publish an SDK-compatible object schema through `tools/list`.
- Enforce both success-state pairings at runtime and retain a discriminated TypeScript handler
  result type.
- Exercise `registerAgentDeckToolDefinitions`, MCP `tools/list`, and MCP `tools/call` through linked
  in-memory transports; the old union fails this path with the reported `_zod` exception.
- Add negative contract cases for mismatched state/effective timing and missing or unexpected
  cleanup metadata.

## Validation and evidence

- Focused MCP tests: 3 files / 106 tests passed.
- Full suite: 439 files passed, 1 skipped; 3,646 tests passed, 1 skipped.
- Node and renderer TypeScript checks passed.
- Production build, logger guard, review-expiry analysis, and whitespace validation passed.
- The published SDK JSON schema has `type: object` and both state enum values; a real MCP call
  returns the `waiting-tool-result` structured payload without `isError` or an exception.

## Residual risk

- Zod refinements are runtime checks and are not fully representable in the JSON schema emitted by
  `tools/list`; the field descriptions and tool description therefore remain the discoverable
  cross-field contract, while server-side validation is authoritative.
- The running Electron main process still contains the old registered schema. Restart is required
  before retrying the already durable exit transition; restarting the user's active session was
  intentionally not attempted during this repair.

## Follow-up

- Retry `exit_worktree` after the app is running this build. No manual worktree removal is needed or
  authorized.
