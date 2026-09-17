---
review_id: 247
reviewed_at: 2026-08-13
baseline_commit: c2a0a1ea4077d67fcfc1ea242d7caae7600b0222
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_247_feishu-p0-surface-cleanup: Dormant product surface removal

## Scope and method

The review began with the repository review-expiry inventory and used no prior review exemption for
the changed implementation. It compared the accepted P0 audit manifests against every changed
contract, Core runtime, Remote facade, Local IPC/preload bridge, renderer consumer, persistence
aggregate, and compatibility reader. It also traced surviving Agent/MCP collaboration and pending
permission/runtime-control paths to ensure that deleting product entry points did not remove their
independent business owners.

```review-scope
README.md
src/contracts/capabilities.ts
src/contracts/current-api-classification.ts
src/contracts/index.ts
src/contracts/method-surface.test.ts
src/contracts/methods.ts
src/hosts/daemon/connection-handshake.ts
src/hosts/daemon/connection.test.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/session-metadata-runtime.test.ts
src/hosts/server-core/session-metadata-runtime.ts
src/main/__tests__/_shared/mocks/agent-deck-team-repo.ts
src/main/agent-deck-mcp/__tests__/task-events.test.ts
src/main/agent-deck-mcp/tools/handlers/task-create.ts
src/main/agent-deck-mcp/tools/handlers/task-update.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/event-bus.ts
src/main/index/_deps.ts
src/main/index/bootstrap-wiring.ts
src/main/index/__tests__/_deps.test.ts
src/main/index/__tests__/bootstrap-wiring-observability.test.ts
src/main/ipc/diagnostics.ts
src/main/ipc/__tests__/diagnostics.test.ts
src/main/ipc/index.ts
src/main/ipc/remote-host.ts
src/main/ipc/sessions.ts
src/main/remote-host/index.ts
src/main/remote-host/input-validation-session-metadata.ts
src/main/remote-host/input-validation-usage.ts
src/main/remote-host/input-validation-usage.test.ts
src/main/remote-host/resource-invalidation.ts
src/main/remote-host/resource-invalidation.test.ts
src/main/remote-host/service-lifecycle-races.test.ts
src/main/remote-host/service-session-metadata.test.ts
src/main/remote-host/service-session-metadata.ts
src/main/remote-host/service-usage.ts
src/main/remote-host/service-usage.test.ts
src/main/remote-host/service.ts
src/main/session/manager-team-coordinator.ts
src/main/store/__tests__/repo-tiebreaker.test.ts
src/main/store/agent-deck-team-repo/index.ts
src/main/store/agent-deck-team-repo/member-query.ts
src/main/store/agent-deck-team-repo/team-crud.ts
src/main/store/event-repo.ts
src/main/store/file-change-read-repo.ts
src/main/store/file-change-repo.ts
src/main/store/message-lifecycle-scheduler.ts
src/main/store/session-repo/core-crud.ts
src/preload/api/events.ts
src/preload/api/remote-host.ts
src/preload/api/sessions.ts
src/preload/index.ts
src/renderer/components/LocalHistorySummaryCard.tsx
src/renderer/components/MarkdownText.tsx
src/renderer/components/RemotePendingBucketSection.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/SessionDetail/MessagesPanel.tsx
src/renderer/components/SessionDetail/TasksPanel.tsx
src/renderer/components/SessionDetail/panels-errors.test.tsx
src/renderer/components/SessionListPrimitives.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/session-presentation.ts
src/renderer/components/session-presentation.test.ts
src/renderer/remote-host/AppHeader.source-mode.test.tsx
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
src/renderer/remote-host/remote-dialogs-test-fixture.ts
src/renderer/remote-host/session-detail-source-shell-test-fixture.ts
src/renderer/remote-host/use-remote-host-snapshot.test.tsx
src/shared/ipc-channels.ts
src/shared/remote-host/session-request-types.ts
src/shared/remote-host/types.ts
src/shared/types/agent-deck-team.ts
```

All deleted Team/permission source files and their removed tests were reviewed through the exact
file manifest in the [archived P0 cleanup batch](../../plans/recent-3-days/PLAN_38_feishu-one-click-server/feishu-one-click-p0-cleanup-batch.md);
they cannot provide future file-level coverage because they no longer exist.

## Findings and fixes landed

### MEDIUM — Page deletion could sever live Session Tasks and Messages

Several live Session views imported time/adapter labels from `TeamDetail`, while session message
reads, notifications, and summarizer diagnostics were registered from `teams.ts`. Deleting the
page tree without first moving these owners would break current Session behavior. The helpers now
live in `session-presentation.ts`, message reads/events live with sessions/events, and diagnostics
have their own IPC registrar with focused coverage.

### MEDIUM — Product Team RPC and trusted collaboration shared names but not ownership

The removed Desktop/Remote Team CRUD facade was a client product projection. Agent/MCP team
membership, messages, tasks, handoff, lifecycle cleanup, and persistence use separate internal
repositories and runtime paths. Cleanup was constrained to the facade and its two dead aggregates;
the internal model, event invalidation of session projections, and uncertain `listByTeam` aggregate
remain intact. Full and Electron-native suites cover those retained paths.

### LOW — One compatibility fallback had no supported producer or artifact

Both Codex file-change readers accepted an object-valued `{ type }` change kind even though the
current translator canonicalizes strings before persistence and current schema readers are
string-only. The evidence-gated fallback was removed from both readers together. No other
compatibility branch was changed.

No confirmed finding remains open in T0 scope.

## Validation and evidence

- Accepted P0-A/P0-B reports were read-only and matched the clean dispatch baseline and plan hashes.
- Exact symbol searches found no remaining Team page/CRUD or session-permission product RPC chain;
  surviving Team symbols belong to protected collaboration internals.
- Focused Electron validation passed 15 files / 75 tests; additional renderer/resource suites
  passed 5 files / 41 tests; Electron-native runtime/SQLite suites passed 2 files / 14 tests.
- `pnpm typecheck`, `pnpm check:architecture`, the full 952-file / 6,049-test suite, and `pnpm build`
  passed (2 files and 3 tests skipped by their existing opt-in guards).
- An isolated temporary development instance loaded rebuilt main/preload code, initialized a fresh
  schema, listened on port 47831, reached a healthy renderer, and shut down cleanly without changing
  the running installed application.
- `git diff --check` passed and no changed production TypeScript/JavaScript file exceeds 500 lines.

## Residual risk

The P0 cleanup deliberately retains `agentDeckMessageRepo.listByTeam` because absence of a current
renderer caller is insufficient expiry evidence for the collaboration persistence contract. T1
must derive Remote Owner Product v1 from the cleaned explicit method directory, not from internal
repository capabilities.

## Follow-ups

Proceed with T1 topology normalization and Server-issued grant claims. No P0 remediation remains.
