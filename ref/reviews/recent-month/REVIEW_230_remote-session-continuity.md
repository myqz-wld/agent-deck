---
review_id: 230
reviewed_at: 2026-08-11
baseline_commit: a043c507aa6cbb8d039c974461d931dacc75d96f
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog maintenance are mechanical records."
---

# REVIEW_230_remote-session-continuity: Remote continuity and active input

## Scope and method

This deep review covered the complete protocol 2.3 Remote context, handoff, active-turn input,
adapter image, Provider Supervisor, deployment, and detail-tab parity batch from baseline
`a043c507`. The user confirmed two heterogeneous reviewers: Claude Code through
`deepseek/deepseek-v4-flash[1m]` at `max` thinking and Codex CLI with `gpt-5.6-sol` at `low`
thinking. Both reviewers read every tracked modification and untracked source file, ran independent
risk-focused validation, rebutted material findings, and repeated bounded post-fix review until
both reported `CONVERGED` with no remaining finding.

```review-scope
deploy/examples/relay-worker.config.example.json
deploy/linux/relay/README.snippet.md
deploy/linux/relay/static-check.sh
resources/bin/agent-deck-worker
scripts/check-deployment-automation.mjs
scripts/deployment/config.mjs
scripts/deployment/deployment.test.mjs
scripts/deployment/worker-supervisor.mjs
scripts/deployment/worker.mjs
src/contracts/capabilities.ts
src/contracts/index.ts
src/contracts/method-surface.test.ts
src/contracts/methods.ts
src/contracts/session-console-capabilities.ts
src/contracts/session-context.test.ts
src/contracts/session-context.ts
src/contracts/session-handoff.test.ts
src/contracts/session-handoff.ts
src/contracts/session-input.test.ts
src/contracts/session-input.ts
src/hosts/daemon/connection-handshake.ts
src/hosts/daemon/connection.test.ts
src/hosts/local-worker/entrypoint.ts
src/hosts/local-worker/provider-credential.test.ts
src/hosts/local-worker/provider-credential.ts
src/hosts/local-worker/terminal-service.test.ts
src/hosts/local-worker/terminal-service.ts
src/hosts/server-core/mcp-handoff-errors.ts
src/hosts/server-core/mcp-handoff-port.ts
src/hosts/server-core/mcp-handoff-preview.ts
src/hosts/server-core/mcp-handoff-target.test.ts
src/hosts/server-core/mcp-handoff-target.ts
src/hosts/server-core/mcp-handoff.test.ts
src/hosts/server-core/mcp-handoff.ts
src/hosts/server-core/mcp-server.test.ts
src/hosts/server-core/provider-inference-credential.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-core.test-fixture.ts
src/hosts/server-core/runtime-core.test.ts
src/hosts/server-core/runtime-core.ts
src/hosts/server-core/runtime-handoff.ts
src/hosts/server-core/runtime-mutation.ts
src/hosts/server-core/runtime-provider-container.ts
src/hosts/server-core/runtime-session-extras.ts
src/hosts/server-core/runtime-validation.ts
src/hosts/server-core/session-attachment-capability.ts
src/hosts/server-core/session-create-capabilities.ts
src/hosts/server-core/session-manager-observer.ts
src/hosts/server-core/session-manager.test.ts
src/hosts/server-core/session-manager.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.message-controller.test.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
src/main/adapters/codex-cli/adapter-core.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/grok-build/__tests__/transport-recovery.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/adapter-core.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/message-controller.ts
src/main/adapters/grok-build/transport-recovery.ts
src/main/adapters/grok-build/turn-queue-helpers.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/types/agent-adapter.ts
src/main/ipc/remote-host.ts
src/main/remote-host/index.ts
src/main/remote-host/input-validation-session-handoff.test.ts
src/main/remote-host/input-validation-session-handoff.ts
src/main/remote-host/service-lifecycle-races.test.ts
src/main/remote-host/service-scope.ts
src/main/remote-host/service-session-handoff.test.ts
src/main/remote-host/service-session-handoff.ts
src/main/remote-host/service-session-mutations.ts
src/main/remote-host/service-session-state.test.ts
src/main/remote-host/service-session-state.ts
src/main/remote-host/service.ts
src/preload/api/remote-host.ts
src/protocol/version.test.ts
src/protocol/version.ts
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.notice.test.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/SessionDetailShell.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
src/renderer/remote-host/remote-session-actions.ts
src/renderer/remote-host/remote-session-detail-load.ts
src/renderer/remote-host/source-types.ts
src/renderer/remote-host/use-remote-business-runner.test.tsx
src/renderer/remote-host/use-remote-business-runner.ts
src/renderer/remote-host/use-remote-session-source-isolation.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/shared/ipc-channels.ts
src/shared/remote-host/types.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A successful terminal handoff could be converted to `stale_scope` after the Core had already created the successor and finalized the source. | Add a terminal scoped request path that preserves successful Core results while allowing navigation only under the still-current source/profile/client identity. |
| MEDIUM | Grok image capability publication used an adapter-global probe instead of the selected live session's ACP negotiation. | Add a session-aware adapter capability query and use it for both publication and Core pre-persist send/steer enforcement. |
| MEDIUM | The edited Relay README removed the exact `runtime-paths` token required by its static deployment contract. | Restore the exact official command reference and rerun Relay, deployment, and Linux headless checks. |
| LOW | A source-finalization warning could survive a session switch and shadow the newly selected session's error. | Bind the notice to the successor session and clear it across source identity changes. |
| LOW | The first notice fix cleared the warning during the real selected-session-null transition before the successor loaded. | Store `{sessionId, text}` and render only for the matching loaded successor; add a stateful transition test. |
| INFO | Adapter-global Grok image policy could briefly disagree with a mixed live runtime after an in-place CLI change. | Resolved by the same selected-session ACP authority used for the MEDIUM finding. |

All paired-review findings are fixed. Both reviewers independently verified final integration and
reported no remaining CRITICAL, HIGH, MEDIUM, LOW, or INFO finding.

## Post-review live finding

Real Grok/xAI acceptance exposed one additional bounded status defect: provider completion emitted
`finished`, then failed ACP transport recovery appended an assistant error message without another
terminal event. The generic activity state machine therefore moved the session back to `working`.
Commit `1d08bedd` changes the recovery contract to emit a terminal error (message plus `finished`),
adds the targeted transport-recovery assertion, and passed the full 901-file suite. A fresh real
Grok session receiving xAI 402 then settled at `active-finished`, directly proving the correction.

## Deep-risk disposition

- Protocol 2.3 gates context, active input, and handoff at negotiated minor 3. Older desktops and
  Cores remain compatible and fail closed to the established text-only surface.
- Handoff preview binding covers source event/runtime preconditions, target adapter/options,
  capability revision, preparation hash, and Workspace-relative cwd. Commit re-resolves under Core
  authority, is idempotent, and cannot navigate a replacement desktop identity.
- Context snapshots are Worker repository/runtime-identity authoritative and reject stale,
  unattributed, or cross-adapter snapshots; compaction resets used-token state.
- Attachment contracts enforce MIME, count, per-item, total bytes, strict base64, and decoded-byte
  equality. Provider mapping remains native: Claude queue, Codex local-image steer, and Grok ACP
  interject only after per-session image negotiation.
- Provider Supervisor credentials are exact-schema, mode-0600, bounded, atomically projected into
  Worker-private state, and never logged. Managed LaunchAgent mutation has rollback and official
  readiness/verification gates; Linux remains explicit/manual.
- Local and Remote share the detail shell without extra Pending/Runtime tabs. Remote context,
  handoff, assets, settings, and input never fall back to Local data or paths.

## Validation

- Reviewers independently passed 161 focused tests (Codex final pass) and 95 focused tests across
  Node/Electron runners (Claude final integration pass), plus `pnpm typecheck`, deployment/static
  checks, Linux headless checks, and `git diff --check`.
- Final lead validation passed 901 files / 5,789 tests; 2 files / 3 tests were skipped.
- Production build, Linux headless packaging, deployment automation, macOS Worker sandbox, arm64
  installer packaging, and packaged Worker sandbox checks passed.
- All production TypeScript/TSX files in the reviewed batch remained below the repository's
  500-line limit.

## Deployment and live evidence

- Commits `581008511418c77e1a59419f87a1999e82c01356` and
  `1d08bedddc8ccf20803a51a166edbf61596dbf18` are pushed and aligned with `origin/main`.
- Installed application build metadata is exact clean commit `1d08bedd`.
- Official Relay upgrade and verification report release `git-1d08bedddc8c`, digest
  `localhost/agent-deck-relay@sha256:5a283579603442bde6e66fab436aa9a3e52e18feeb3d5086fdf45def76039d6f`,
  and healthy status.
- Official Worker verification reports `worker-df9dfaddfd410be3979119c7` running and managed
  Supervisor `aws-relay-on-mac` running. A post-upgrade protocol probe observed version 2.3,
  26 capabilities, authoritative Core generation 1, all three adapters enabled, and three final
  sessions at `active-finished`.
- Claude/DeepSeek and Codex returned their exact success markers in sessions
  `a03c9ef3-9b8e-4b63-b682-615fe72209b4` and
  `019ff181-dc5b-7ed2-acbd-685bd9c9955a`. Both live ACP/input descriptors advertise images enabled
  for their provider-native active-turn modes.
- Grok session `f009c96d-ae08-4f06-82d5-beae8c734a06` reached xAI and received an external
  `402 Payment Required`; it correctly finished. Its selected ACP runtime advertised image input
  false, so Remote stayed text-only without silently attempting an unsupported image.

## Residual operational constraints

- Successful Grok model output remains blocked by the xAI account's current credits/subscription,
  not by Relay, Worker, Supervisor, container, broker, authentication transport, or protocol.
- The projected OAuth access credential is intentionally not a refresh-token store. Renew it
  through the official credential/deployment flow after `grok login`, or configure a paid API key.
- The final Worker upgrade command's last `launchctl kickstart -k` returned exit 5 after the new
  exact-commit app had already launched the Worker. Independent official verification and the fresh
  Core PID/identity prove the desired runtime active. No direct process signal or forced restart was
  used; the misleading command outcome remains a bounded deployment UX follow-up.

## Verdict

PASS. Protocol, source authority, handoff terminality, context attribution, provider-native active
input, tab parity, Supervisor security, and deployment gates are converged. The installed Worker and
managed Relay are healthy on the pushed release, Claude/Codex real sessions pass, and Grok reaches
the provider while failing only on the account's external payment gate.
