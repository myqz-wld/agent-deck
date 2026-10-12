---
review_id: 319
reviewed_at: 2026-10-12
baseline_commit: 9928f3e03bcc8f1cb7a788e56556992ea1dcbaff
expired: false
---

# Feishu closed assistant recovery

## Scope and method

Owner-reported failure diagnosis using read-only gateway metadata and normalized Core error
events, source tracing, a reproduction with the real Core session manager and MCP broker,
and targeted and full regression validation. No independent reviewers were requested.
The file-level review expiry helper completed; coverage is limited to the files below.

```review-scope
src/gateways/im/conversation-router.ts
src/gateways/im/conversation-router.test.ts
src/hosts/server-core/feishu-codex-recovery.test.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host-core.ts
```

## Findings and fixes

HIGH: A retained Codex assistant could not resume after its lifecycle became closed. Feishu
defers the user event until native turn acceptance. Recovery therefore skipped the early user
event that normally reactivates the identity. The Core MCP broker correctly rejected the
still-closed session with HTTP 401 during required MCP initialization, so native resume failed
before the deferred event could arrive. Subsequent delivery retries encountered an uncertain
mutation claim and surfaced `provider_lost`.

Deferred recovery now explicitly reactivates a previously closed identity after unarchiving and
checking the close epoch. Existing failure rollback closes it again if native startup fails.
Provider identity, native history, model, sandbox, approval policy, and deferred input semantics
remain unchanged. MCP authentication still rejects unresumed closed, archived, and released
identities. The change does not permit arbitrary late provider events to revive a session.

MEDIUM: Assistant connection errors directed the owner to `/sessions`, which lists work sessions.
Assistant failures now reference `/chat list` and `/chat new`, explain retained history, and leave
both selections intact. Work-session failure guidance retains its existing commands.

## Validation and evidence

- The new integration regression reproduced HTTP 401 before the fix, without launching a real
  provider or sending a message to Feishu.
- Four recovery cases cover closed and archived identities, successful MCP initialization before
  user-event persistence, exactly one accepted user event, startup failure rollback, and a new
  close while unarchiving.
- 62 focused tests pass, including existing MCP authentication and Codex recovery cancellation.
- `pnpm typecheck` passes, including architecture and Core Node boundary checks.
- `pnpm test`: 1,142 files pass, 3 files skip; 7,114 tests pass, 6 opt-in tests skip.
- `pnpm build` passes. `pnpm build:linux-headless` passes its two-build reproducibility check
  and bundled Worker/Feishu dependency checks.

## Residual risk and activation

Live acceptance remains pending. The installed macOS application supplies the Relay Worker
runtime; the owner approved its replacement, reopening, and managed-service pause/restore after
source validation. The gateway copy change requires its own managed Feishu runtime upgrade.
No installed files, live state, tokens, provider processes, or remote services were changed.
Existing uncertain delivery keys remain fenced; after activation, a fresh owner message can
resume the same conversation. No mutation ledger entries were deleted or retried manually.

All changed source files remain below 500 lines; no split exemption is required. README changes
are unnecessary for this bug fix. Diagnostic artifacts remain private outside distribution inputs.

## Follow-ups

Complete approved activation and verify an owner message reaches the retained assistant.
See [installation handoff](../../plans/recent-3-days/PLAN_85_feishu-assistant-recovery.md).
