---
review_id: 301
reviewed_at: 2026-09-30
baseline_commit: b00a2a6a133e7ac2b52a89eb44ac301a20f79bee
expired: false
---

# Feishu work directory and old inbound events

## Scope and method

Locally inspected the changed producer/consumer contracts, runtime wiring, role persistence,
pagination, native MCP metadata, gateway recovery and message admission. The owner prohibited new
agents, so this is a local review with no independent or paired-review claim. Read normalized Core
activity and private metadata; no raw provider transcript or credential is included here.

```review-scope
src/contracts/feishu-assistants.ts
src/contracts/grant-policy.ts
src/contracts/grant-policy.test.ts
src/contracts/index.ts
src/contracts/methods.ts
src/gateways/feishu/core-verification.test.ts
src/gateways/feishu/event-adapter.ts
src/gateways/feishu/event-adapter.test.ts
src/gateways/feishu/mapper.ts
src/gateways/im/__tests__/fixture.ts
src/gateways/im/assistant-registration.ts
src/gateways/im/assistant-registration.test.ts
src/gateways/im/command-executor.ts
src/gateways/im/conversation-prompt.ts
src/gateways/im/conversation-router.ts
src/hosts/daemon/connection.test.ts
src/hosts/server-core/feishu-assistant-store.ts
src/hosts/server-core/feishu-assistants-runtime.ts
src/hosts/server-core/feishu-assistants-runtime.test.ts
src/hosts/server-core/feishu-work-session-directory.ts
src/hosts/server-core/feishu-work-session-directory.test.ts
src/hosts/server-core/mcp-feishu-work-sessions.ts
src/hosts/server-core/mcp-feishu-work-sessions.test.ts
src/hosts/server-core/mcp-server.ts
src/hosts/server-core/mcp-tool-host-production.ts
src/hosts/server-core/mcp-tool-host.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-mcp-host.ts
src/protocol/version.ts
src/protocol/version.test.ts
deploy/linux/feishu/README.md
```

## Findings and fixes landed in source

MEDIUM: Successful generic MCP listing returned the assistant itself as the sole active related
session. The owner console also had a dormant work selection. Work identity and discoverability
were therefore not equivalent to the collaboration list. Add an owner-attested assistant-purpose
registry and a separate read-only work directory; do not infer purpose from titles/models or
weaken generic history permissions. Keep mutation policies, model choices and Workspace intact.

MEDIUM: A separate old directory command arrived after the assistant's query response. The
Feishu event console reported four platform retries and a successful final push lasting 2,187 ms;
the local ledger showed two attempts and about 1.9 seconds for the last processing attempt.
The assistant's normalized activity contained only its session-list tool call. The callback mapper
accepts user senders only. This was a separate retried incoming message, not a reflected assistant
tool result. The original send time was not retained by the available local/console evidence;
do not attribute the full delay to model execution or claim exact timing reconstruction.

At the owner's direction, ignore input older than five minutes. Compare original message time,
not callback-envelope time, before pairing or Core access. Acknowledge expired input so Feishu
stops retrying it. Do not add late-reply cards or extra timing logs. Normal admitted work and
its subsequent provider replies retain their existing lifecycle.

## Validation and evidence

- Sixteen new directory regressions cover all three MCP adapters, serialized read annotations,
  unavailable callers, active/dormant work, same titles/models, handoff identity, paging after
  filtering, bounded empty-page continuation, legacy registration, reconnects, idempotency,
  uncertain-write recovery, private file validation and group isolation.
- Five new expiry regressions cover second/millisecond/microsecond timestamps, a fresh callback
  wrapping an old message, the exact five-minute boundary, no pairing/Core calls, stopped retries
  and already-admitted work finishing after the boundary.
- Full suite: 6,792 passed, three existing opt-in skips. Architecture/typecheck, application build
  and final Linux reproducibility passed. The shared Electron SQLite binding stayed unchanged.
- Both pinned amd64/arm64 archives passed native runtime checks. Each contains 37 members and
  26 regular files; all archive bytes and 11 headless bundles passed private-value/path scans.
  Final headless static/package and deployment gates passed.
- Rechecked native permission preservation and unchanged generic collaboration/history contracts.
  The new directory only projects metadata already available through the owner console.
- The owner explicitly approved the two prompt assets: the new tool-description file and the
  existing shared conversation prompt. The local inventory was refreshed; Claude/Codex runtime
  instruction counterparts were read without changes. No standing custom points were added.
- The expiry helper reports legacy coverage gaps; no prior coverage was treated as an exemption.
  Every changed file above was inspected. All changed source files remain below the size ceiling.

## Residual risk and follow-ups

This repair is installed in the coordinated protocol-2.11 release `410a6db9`; Desktop identity,
Worker, Relay and exact active Feishu archive passed independent checks. No migration or pairing
operation ran. See [installation acceptance](../../plans/recent-3-days/PLAN_70_feishu-native-controls-activation.md).
Actual assistant work-directory results, work messages and the new pending-card presentation still
need owner acceptance before closing the overall Feishu plan.
Paged work metadata reflects current state, so concurrent session changes can move rows between
pages. A non-null continuation is never proof that all work has already been listed.

Private diagnostics remain under `$HOME/.agent-deck/diagnostics/feishu-response-recovery/`.
See [CHANGELOG_660](../../changelogs/recent-3-days/CHANGELOG_660_feishu-work-directory-expiry.md).
