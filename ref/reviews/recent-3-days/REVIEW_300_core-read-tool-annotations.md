---
review_id: 300
reviewed_at: 2026-09-30
baseline_commit: 825a6c487705bab19a5b8209d47ca6d778997743
expired: false
---

# Server Core read-only MCP approvals

## Scope and method

Diagnosed the owner's real Feishu assistant reply using bounded normalized Core history and
metadata, then traced MCP registration and compared Desktop read annotations. Reviewed the full
changed scope locally; no independent or paired reviewer was used because the owner prohibited
new agents. This repair changes executable MCP metadata, not prompt descriptions or native policy.

```review-scope
src/hosts/server-core/mcp-tool-host.ts
src/hosts/server-core/mcp-session-tools.ts
src/hosts/server-core/mcp-task-tools.ts
src/hosts/server-core/mcp-feishu-preferences.ts
src/hosts/server-core/mcp-read-annotations.test.ts
```

## Finding and fix landed

HIGH: Server Core exposed session list/get/events, task list/get and Feishu preference reads without
read-only tool annotations. The installed Codex 0.159.2 rejected the actual `list_sessions` call
because it required approval while the saved native approval policy was `never`. The rejection
occurred before the read and generated no pending request. Ordinary assistant replies and a fast
second-turn recall succeeded, separating this defect from transport or missing chat history.

The pinned [Codex MCP approval implementation](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs)
uses read-only annotations for its default approval decision and treats missing hints conservatively.
The observed native error and absent published metadata match that path.

Publish one shared read-only annotation set on exactly those six read tools: read-only, non-destructive,
idempotent and closed-world. Keep existing caller/ownership checks, input/output contracts,
Workspace limits, saved models, approval policy and mutation-tool metadata. Native explicit prompt
or administrative policy remains authoritative; no blanket approval configuration is added.

## Validation and evidence

- A wire-level MCP discovery regression failed on all three adapter variants before the fix;
  the unavailable-caller check already passed. After the fix, all four regression cases pass.
- Related MCP server and Feishu preference checks: 12 tests passed. They cover serialized tool
  discovery, mutation/read classification, caller rejection and the existing success contracts.
- Full suite: 6,771 passed, three existing opt-in skips; architecture and both typechecks passed.
- Linux headless build, headless static/package checks and deployment checks passed.
- The accepted amd64/arm64 Feishu runtime archives were recovered from the verified installed app
  into generated build inputs. Both gateway payloads match the current build byte-for-byte. The
  repair needs a Worker/Core activation; the Relay and Feishu payloads do not need another upgrade.
- The shared Electron SQLite binding hash remained unchanged. All changed files are below 500 lines.
- Ran the expiry helper; it still exits nonzero on legacy coverage gaps. No prior coverage was
  treated as an exemption, and every file above was inspected. Rebucketed dated review records.

Private evidence is retained under `$HOME/.agent-deck/diagnostics/feishu-response-recovery/`.
No raw provider transcript, owner identifier, credential, pairing code or private endpoint is published.

## Latency and remaining acceptance

The initial assistant bootstrap took about 28 seconds from session creation to its first visible
reply and about 42 seconds to its final reply. Delivery itself took about 1-2 seconds. The first
callback deadline led to a successful retry; the bootstrap also ran a setup turn before the owner's
message. The owner confirmed that a later turn recalled the synthetic test word quickly. This patch
does not change the selected model/thinking level or redesign cold-start admission.

The repair is installed as `0a4299b96ce21a66a0b22186dd021c589adddead`. Independent checks confirm
the packaged Worker contains all six annotations, one GUI process is running, and Worker/Relay/
Feishu health passes. The owner's retry in the same assistant chat completed the real
`mcp__agent-deck__list_sessions` call in about 8 ms, with no native approval denial or tool error.
This accepts the read-only annotation repair. Installation evidence is archived in
[PLAN_69](../../plans/recent-3-days/PLAN_69_core-read-tool-activation.md).

The returned entry was the assistant itself. The owner console separately contains one dormant
work session. Generic MCP listing defaults to active caller-related sessions, so successful tool
execution does not establish correct work-session classification. That in-scope semantic repair
remains open; preserve generic collaboration and event-history contracts while supplying an
explicit work-session view. No session identifiers or reply bodies are included in this record.
Work-session routing/cards and a real pending-card decision remain separate open acceptance checks.
The overall Feishu plans remain active. No new follow-up issue is created for this in-scope repair.
