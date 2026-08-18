---
review_id: 226
reviewed_at: 2026-08-10
baseline_commit: 4d933d362cf03ff1211ef71592ff71eb5b92bc9d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review, changelog, plan, and bucket-index maintenance are mechanical records."
---

# REVIEW_226_remote-full-page-parity: Remote full-page parity and authority

## Scope and method

This deep review covered the complete Local/Remote parity batch from baseline `4d933d36`.
The user confirmed two heterogeneous reviewers: Claude Code through
`deepseek/deepseek-v4-flash[1m]` at `max` thinking, and Codex CLI. Both reviewers read every
tracked modification and untracked source file, completed rebuttal, verified fixes, and repeated a
targeted post-fix review for the permission-preview redaction boundary.

```review-scope
src/contracts/capabilities.ts
src/contracts/index.ts
src/contracts/method-surface.test.ts
src/contracts/methods.ts
src/contracts/permission-preview.test.ts
src/contracts/permission-preview.ts
src/contracts/teams.test.ts
src/contracts/teams.ts
src/contracts/usage.test.ts
src/contracts/usage.ts
src/gateways/im/redaction.ts
src/hosts/daemon/connection-handshake.ts
src/hosts/daemon/connection-test-helpers.ts
src/hosts/daemon/connection.test.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-core.test.ts
src/hosts/server-core/runtime-pending.test.ts
src/hosts/server-core/runtime-pending.ts
src/hosts/server-core/team-runtime.test.ts
src/hosts/server-core/team-runtime.ts
src/hosts/server-core/usage-runtime.test.ts
src/hosts/server-core/usage-runtime.ts
src/main/ipc/remote-host.ts
src/main/remote-host/business-validation.test.ts
src/main/remote-host/business-validation.ts
src/main/remote-host/index.ts
src/main/remote-host/input-validation-teams-usage.test.ts
src/main/remote-host/input-validation-teams-usage.ts
src/main/remote-host/input-validation.test.ts
src/main/remote-host/input-validation.ts
src/main/remote-host/pending-response-policy.ts
src/main/remote-host/pending-response.test.ts
src/main/remote-host/service-teams-usage.test.ts
src/main/remote-host/service-teams-usage.ts
src/main/remote-host/service.test.ts
src/main/remote-host/service.ts
src/preload/api/remote-host.ts
src/protocol/version.test.ts
src/protocol/version.ts
src/renderer/App.tsx
src/renderer/AppWorkspace.remote-parity.test.tsx
src/renderer/AppWorkspace.tsx
src/renderer/app-view-catalog.ts
src/renderer/components/AppHeader.tsx
src/renderer/components/DataPanel.tsx
src/renderer/components/HeaderTokenRates.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/TeamDetail/EventsSection.tsx
src/renderer/components/TeamDetail/LineageSection.tsx
src/renderer/components/TeamDetail/MembersSection.tsx
src/renderer/components/TeamDetail/MessagesSection.tsx
src/renderer/components/TeamDetail/PendingSection.tsx
src/renderer/components/TeamDetail/__tests__/TeamDetail.test.tsx
src/renderer/components/TeamDetail/__tests__/ViewersDetail.test.tsx
src/renderer/components/TeamDetail/index.tsx
src/renderer/components/TeamDetail/member-candidates.ts
src/renderer/components/TeamHub.tsx
src/renderer/components/__tests__/DataPanel.test.tsx
src/renderer/components/__tests__/HeaderTokenRates.source.test.tsx
src/renderer/components/new-session/session-option-catalog.test.ts
src/renderer/components/new-session/session-option-catalog.ts
src/renderer/components/pending-rows/AskRow.tsx
src/renderer/components/pending-rows/PermissionRow.tsx
src/renderer/components/pending-rows/RemotePendingFallbackRow.tsx
src/renderer/components/pending-rows/RemotePendingRequests.tsx
src/renderer/components/team-data-source.test.tsx
src/renderer/components/team-data-source.ts
src/renderer/hooks/use-token-rates-poll.ts
src/renderer/remote-host/AppHeader.source-mode.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemotePendingRequests.test.tsx
src/renderer/remote-host/remote-pending-presentation.ts
src/renderer/remote-host/session-summary-presentation.test.ts
src/renderer/remote-host/session-summary-presentation.ts
src/renderer/remote-host/source-navigation.test.ts
src/renderer/remote-host/source-navigation.ts
src/renderer/remote-host/use-remote-session-source.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/remote-host/use-remote-usage-source.test.tsx
src/renderer/remote-host/use-remote-usage-source.ts
src/shared/ipc-channels.ts
src/shared/remote-host/pending-semantics.ts
src/shared/remote-host/types.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A new `usage` HostHello capability was advertised under protocol 2.0, whose older strict desktops reject unknown capabilities. | Bump to protocol 2.1 and advertise Usage only when the negotiated minor supports it; retain established Teams and other 2.0 capabilities. |
| HIGH | Remote permission projection discarded material Edit, Write, and MCP input while still enabling approval. | Add a bounded, schema-validated, recursively redacted preview and fail closed for incomplete approval in Renderer, Main, and Core while retaining deny. |
| MEDIUM | A lost pending-response result could not replay because Main required the request to remain pending before consulting Core idempotency. | Bind the displayed presentation by SHA-256 digest and forward exact uncertain retries to the authoritative Core mutation ledger. |
| MEDIUM | `teams.add-member` checked mutable Team state before replaying a completed idempotency claim. | Claim/replay before mutable validation and release newly invoking claims after definitive pre-effect rejection. |
| MEDIUM | The first preview redactor missed common names such as `token`, `client_secret`, `x_api_key`, and `credential`. | Share one conservative sensitive-key predicate with the IM redactor and prove Contract → Core → DOM concealment. |
| LOW | Unrelated global revision churn rejected an unchanged pending presentation on first click. | Validate the canonical presentation digest and forward the fresh current revision to Core. |
| LOW | Extended non-native exit-plan displays exposed target-mode actions that Main rejected. | Share one exact native parser; unrecognized shapes use value-less compatibility actions. |

All material findings are fixed and both reviewers converged on release.

## Validation and evidence

- `pnpm test` passed 876 files and 5,704 tests; 2 files and 3 tests were skipped.
- Focused correction suites passed 61 tests after the final redaction change.
- `pnpm typecheck` passed architecture and Node/Web TypeScript checks.
- `pnpm build` passed.
- `pnpm verify:linux-headless` passed the headless build, packaging, and deployment checks.
- `pnpm verify:macos-worker-sandbox` passed the signed Worker sandbox boundary.
- The ABI-sensitive runtime-composition suite passed 5 tests through the repository's official
  Electron runner; no dependency rebuild was required.
- `git diff --check` passed and every changed TS/TSX/JS file remains at or below 500 lines.
- Both reviewers completed full initial review, rebuttal, complete post-fix review, and the bounded
  permission-redaction re-review. Reviewer sessions were closed after convergence.

## Fixes landed

- Added bounded DesktopFull Team and Usage method contracts, Core runtimes, Main IPC/service
  validation, and source-isolated renderer data adapters.
- Reused shared Team, Data, session-option, session-summary, Ask, Permission, native ExitPlan, MCP
  plan, and diff presentations across Local and Remote.
- Replaced the hard-coded reduced Remote page list with a capability-gated shared view catalog.
- Preserved exact adapter-owned session-create fields and rejected incompatible fields rather than
  silently ignoring them.
- Restored pending-response presentation binding, retry replay, and Team mutation idempotency.
- Added protocol-minor capability evolution and a fail-closed permission-preview security boundary.

## Residual risk

- Remote History remains explicitly bounded to loaded summaries rather than pretending to provide
  server-side full-text search.
- A narrow revision race can still occur between Main preflight and a new Core mutation; retry is
  safe and idempotent.
- Permission-preview free-form string values are not inspected for embedded high-confidence token
  patterns when their field name is non-sensitive. This matches Local presentation behavior and
  was classified by the paired review as optional LOW hardening, not a Remote regression.
- Live Relay/Worker upgrade and real Claude/Codex acceptance remain release gates after the source
  commit is pushed.

## Final verdict

PASS for source release. All blocking parity, compatibility, authorization, and replay findings are
closed. Deploy only from a clean commit aligned with `origin/main`, then run real Remote Claude
and Codex acceptance without manipulating the existing desktop process.
