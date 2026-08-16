---
review_id: 232
reviewed_at: 2026-08-11
baseline_commit: 012306082ea33db399d642cadf3ba922391183ce
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical and follows the reviewed result."
---

# REVIEW_232_remote-transport-ui-convergence: Remote transport and UI convergence

## Scope and method

This review covered the complete 42-path working-tree correction against the frozen installed-app
baseline. It first established the duplicate request at the desktop SSH client's handshake/state
publication boundary, then reviewed every transport and renderer change for source authority,
capability admission, identity and sequence fencing, request frequency, Local/Remote presentation
parity, and bounded interaction behavior. The repository file-level expiry check was run before the
review; the full batch scope below exceeds the mechanically required minimum re-review scope.

```review-scope
src/clients/ssh/client-admission.test.ts
src/clients/ssh/connection.ts
src/renderer/AppWorkspace.remote-parity.test.tsx
src/renderer/AppWorkspace.tsx
src/renderer/components/AssetsLibraryDialog.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/DataPanel.tsx
src/renderer/components/HeaderTokenRates.tsx
src/renderer/components/RemoteHost/RemoteConnectionCards.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx
src/renderer/components/RemoteHost/RemoteProfileSidebar.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/SessionListPrimitives.tsx
src/renderer/components/SettingsDialog.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/TeamHub.test.tsx
src/renderer/components/TeamHub.tsx
src/renderer/components/__tests__/DataPanel.test.tsx
src/renderer/components/__tests__/HeaderTokenRates.source.test.tsx
src/renderer/components/__tests__/SessionList.parity.test.tsx
src/renderer/components/issues/RemoteIssuesPanel.tsx
src/renderer/components/new-session/RemoteWorkspaceDirectoryDialog.tsx
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/components/team-data-source.test.tsx
src/renderer/components/team-data-source.ts
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/RemotePageAvailability.test.tsx
src/renderer/remote-host/RemotePageAvailability.tsx
src/renderer/remote-host/remote-plan-review-transports.test.ts
src/renderer/remote-host/remote-plan-review-transports.ts
src/renderer/remote-host/session-summary-presentation.test.ts
src/renderer/remote-host/session-summary-presentation.ts
src/renderer/remote-host/use-remote-session-source.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/remote-host/use-remote-source-context.ts
src/renderer/remote-host/use-remote-usage-source.test.tsx
src/renderer/remote-host/use-remote-usage-source.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The SSH connection published `connected` before `onReady` cleared and re-admitted retained requests. A synchronous state observer could therefore send the first request, after which `onReady` forgot that write and sent the identical request again on the same connection. The strict client correctly treated the second terminal response as a protocol violation and disconnected. | Reconcile request bookkeeping through `onReady` before publishing `connected`. Deterministic first-connect and reconnect fixtures assert exactly one request frame; duplicate-response strictness was not relaxed. |
| MEDIUM | Remote usability included reconnecting and recoverable Worker-offline states while negotiated capabilities survived those states. Mounted Teams, Issues, Data, list, and detail consumers could continue calling an unavailable source, allowing rejected work to reach page error boundaries and sustaining visible lag. | Define usability as an exact connected binding and gate all six workspace surfaces through one connected-plus-capability classifier before consumers mount. Direct consumers also reject or make zero calls while unusable. |
| MEDIUM | Several same-identity asynchronous paths relied on profile/Core identity alone. Disconnects that retained that identity could allow late session, usage, Settings/Hook, Assets, Workspace, or creation responses to write stale state. | Add render-time usability/authority refs, admission generations, sequence retirement, visible-state clearing, and stale action checks. Rapid Core generations and same-identity disconnect/reconnect tests prove only current results survive. |
| LOW | The connection manager permanently reserved a wide right-side instructional pane with no persistent information or action value. | Replace the split layout with a compact scrollable single column whose cards own status, error, and actions; keep add/edit as an on-demand overlay. |
| LOW | Remote Live used divergent card markup, spacing, status hierarchy, a Closed-only section, and a decorative profile/count banner. | Share card/header/section/state primitives with Local, render only the Local-equivalent active/dormant policy, retain bounded Load More, and keep the authoritative total in the existing header. |
| LOW | Stable Remote surfaces performed avoidable work: the initial empty Issue keyword scheduled an equivalent filter update, Team adapters changed with unrelated Local stores, and the Remote token header still mounted Local usage hooks. | Eliminate the equivalent Issue update, memoize Remote Team authority independently of Local values, and split Local/Remote token-rate children so Remote never subscribes or polls Local state. |

## Validation and evidence

- The red SSH fixture observed two request frames before any Relay, Worker, or Core response path was
  involved. After the ordering correction, first-connect and reconnect observers each produced one
  frame; strict unknown, queued, conflicting duplicate, cancellation, deadline, replay, and request
  concurrency tests remained green.
- Focused authority and race coverage verified zero Remote business calls while unusable, exact
  capability sets for every page, immediate polling retirement, stale-response rejection across
  same-identity reconnects and Worker generations 1→2→3, stable initial Team/Issues/Data request
  counts, and no Local usage subscription in Remote mode.
- Component coverage exercised empty/one/many connection profiles, long labels/endpoints/errors,
  inline lifecycle actions, confirmation and busy states, Local/Remote card structure, bounded Load
  More, shared loading/error/empty states, and a 512-row interactive list.
- The official Electron suite passed 905 files / 5,848 tests, with 2 files / 3 existing conditional
  skips. `pnpm typecheck` passed architecture, Core/Node, Node, and Web checks.
- `pnpm build`, the official Linux headless build/check/deployment chain, Relay static verification,
  macOS Worker sandbox verification, `git diff --check`, and the production file-size audit passed.
  The standalone Linux checker initially lacked its generated manifest; the official
  `pnpm verify:linux-headless` entrypoint produced the prerequisite and passed, confirming this was
  invocation order rather than a product failure.

## Fixes landed

- SSH handshake state publication now follows internal ready reconciliation.
- Remote page admission, data clearing, async result fencing, action fencing, and polling retirement
  are connected-state authoritative without Local fallback.
- Connection management and session-list presentation are compact and structurally shared.
- Focused regressions cover transport duplication, disconnected pages, stable request counts,
  rapid generation switches, overflow, and long-list interaction.

## Residual risk

- Source, component, full-suite, build, and platform gates cannot prove the currently installed
  desktop is running this new commit. T9 therefore retains a user-install boundary followed by
  non-invasive live connection, sequential-request, page-authority, and real-provider acceptance.
- Relay and Worker entrypoint graphs do not import the changed SSH client, so deploying either would
  add operational risk without changing its artifact. The optional Feishu gateway does share that
  client, but no Feishu service is deployed yet; its package and external configuration remain T10
  work and will inherit this correction when built.

## Follow-ups

- Commit and push the reviewed tree, build the exact macOS package, and ask the user to install it.
- After installation, verify one terminal result per sequential request, stable Team/Issues/Data and
  list behavior, and real Claude/Codex Remote sessions without process manipulation.
- Resume the already scoped Feishu preparation only after Remote live acceptance completes.

## Verdict

PASS for implementation and release-gate readiness. All six findings are fixed with targeted and
repository-wide evidence; no CRITICAL, HIGH, MEDIUM, or LOW finding remains open. Live installed-app
acceptance is explicitly deferred to T9 rather than inferred from source validation.
