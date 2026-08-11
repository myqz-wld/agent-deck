---
review_id: 229
reviewed_at: 2026-08-11
baseline_commit: a72c843ef459dcb1e3f9516cf35d5dd9c48b3905
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog maintenance are mechanical records."
---

# REVIEW_229_remote-worker-ui-authority: Remote UI and Worker authority

## Scope and method

This deep review covered the complete Remote UI, Worker configuration, Hook, asset, session-detail,
attachment, protocol, and SSH reconnect batch from baseline `a72c843e`. The user confirmed two
heterogeneous reviewers: Claude Code through `deepseek/deepseek-v4-flash[1m]` at `max` thinking,
and Codex CLI with `gpt-5.6-sol` at `low` thinking. Both reviewers read every tracked modification
and untracked source file, independently ran risk-focused tests, and repeated bounded post-fix
review until both reported `CONVERGED` with no material finding.

```review-scope
README.md
src/clients/ssh/client.test.ts
src/clients/ssh/client.ts
src/clients/ssh/config.ts
src/clients/ssh/types.ts
src/contracts/capabilities.ts
src/contracts/index.ts
src/contracts/method-surface.test.ts
src/contracts/methods.ts
src/contracts/node-assets.test.ts
src/contracts/node-assets.ts
src/contracts/node-configuration.test.ts
src/contracts/node-configuration.ts
src/hosts/daemon/connection-handshake.ts
src/hosts/daemon/connection.test.ts
src/hosts/server-core/node-asset-catalog.ts
src/hosts/server-core/node-asset-runtime.test.ts
src/hosts/server-core/node-asset-runtime.ts
src/hosts/server-core/node-asset-user-scan.test.ts
src/hosts/server-core/node-asset-user-scan.ts
src/hosts/server-core/node-configuration-runtime.test.ts
src/hosts/server-core/node-configuration-runtime.ts
src/hosts/server-core/provider-claude-query-host.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-grok-host.ts
src/hosts/server-core/provider-host-common.ts
src/hosts/server-core/provider-sandbox-policy.test.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-controls.ts
src/hosts/server-core/runtime-core.test-fixture.ts
src/hosts/server-core/runtime-core.test.ts
src/hosts/server-core/runtime-core.ts
src/hosts/server-core/runtime-history.ts
src/hosts/server-core/runtime-validation.ts
src/main/ipc/remote-host.ts
src/main/plugin-assets.ts
src/main/remote-host/index.ts
src/main/remote-host/input-validation-node-assets.test.ts
src/main/remote-host/input-validation-node-assets.ts
src/main/remote-host/input-validation-node-configuration.test.ts
src/main/remote-host/input-validation-node-configuration.ts
src/main/remote-host/input-validation.test.ts
src/main/remote-host/input-validation.ts
src/main/remote-host/service-node-assets.test.ts
src/main/remote-host/service-node-assets.ts
src/main/remote-host/service-node-configuration.test.ts
src/main/remote-host/service-node-configuration.ts
src/main/remote-host/service-session-mutations.ts
src/main/remote-host/service.ts
src/preload/api/remote-host.ts
src/protocol/version.test.ts
src/protocol/version.ts
src/renderer/App.tsx
src/renderer/AppWorkspace.remote-parity.test.tsx
src/renderer/components/AssetsLibraryDialog.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/SessionContextUsageChip.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.tsx
src/renderer/components/SessionDetail/SessionDetailShell.tsx
src/renderer/components/SessionMetadataChips.tsx
src/renderer/components/SettingsDialog.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/assets/AssetsTab.tsx
src/renderer/components/assets/ContentViewerModal.tsx
src/renderer/components/assets/InjectionToggleBar.tsx
src/renderer/components/assets/RemoteApplicationConventionTab.tsx
src/renderer/components/settings/controls.tsx
src/renderer/components/settings/sections/HookSection.tsx
src/renderer/components/settings/sections/RemoteNodeConfigurationSection.tsx
src/renderer/components/team-data-source.ts
src/renderer/hooks/__tests__/useImageAttachments.remote-limits.test.tsx
src/renderer/hooks/image-attachments/processing.ts
src/renderer/hooks/image-attachments/types.ts
src/renderer/hooks/useImageAttachments.ts
src/renderer/remote-host/remote-intent-ledger.test.ts
src/renderer/remote-host/remote-intent-ledger.ts
src/renderer/remote-host/remote-node-dialog-context.ts
src/renderer/remote-host/source-types.ts
src/renderer/remote-host/use-remote-business-runner.ts
src/renderer/remote-host/use-remote-session-source-isolation.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/remote-host/use-remote-usage-source.test.tsx
src/renderer/remote-host/use-remote-usage-source.ts
src/shared/ipc-channels.ts
src/shared/remote-host/types.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Provider Home asset discovery could traverse, parse, sort, and cache an unbounded plugin inventory before slicing the 512-item wire response. | Stream directory traversal under one 16,416-entry budget, cap plugin roots and manifests, retain at most 513 merged assets, and propagate scan exhaustion as `assetsTruncated`. |
| LOW | Every asset list or content request synchronously re-scanned the complete Worker catalog. | Scan immutable packaged assets once and reuse a five-second bounded Provider Home snapshot; read-time canonical fences remain authoritative. |
| INFO | The Remote image picker advertised a hard-coded MIME set instead of the negotiated Worker policy. | Derive the picker `accept` value from the negotiated attachment descriptor while retaining renderer and wire enforcement. |
| INFO | An open Remote asset viewer could retain content from the previous Worker generation after identity changed. | Invalidate the viewer sequence and state on identity change and bind both success and failure responses to the render-time identity. |
| INFO | Moving the packaged scan into catalog construction could turn a transient read failure into Worker bootstrap failure. | Catch the one-time packaged scan and fail closed to an empty packaged snapshot. |

All findings are fixed. Both reviewers independently verified the final bounded implementation and
reported no new CRITICAL, HIGH, MEDIUM, or LOW finding.

## Authority and parity evidence

- Live, Pending, History, detail, Teams, Issues, Data, session totals, and token rates read only from
  the selected Core in Remote mode. Identity, sequence, and capability gates clear stale results and
  never fall back to Local stores.
- Remote Settings obtains provider defaults from the Worker. Provider Hook install/uninstall uses
  the Worker's isolated Provider Home; local window, notification, shortcut, and log controls are
  separated and labelled as desktop-only.
- Remote Assets reads only Worker packaged resources and isolated Provider Home content. Canonical
  path fencing, full logical identity matching, read-time bounds, list/traversal budgets, and
  read-only UI prevent Local/Finder fallback.
- Remote detail and composer reuse the Local shell, metadata, image, and runtime-control surfaces,
  while adapter-native Claude, Codex, and Grok fields remain strictly validated end to end.
- Protocol 2.2 advertises Usage only at minor 2.1+ and Node configuration/assets only at 2.2+;
  strict 2.0/2.1 desktops do not receive unknown capabilities.
- The SSH client queues above the negotiated Host in-flight limit and re-admits retained requests
  after reconnect, eliminating the misleading incompatibility failure caused by ordinary polling.

## Validation

- Lead focused validation passed 25 Electron files / 137 tests before review.
- Initial reviewers independently passed 54 tests (Codex) and 121 tests (Claude), plus static
  coverage of every changed and untracked source file.
- Final bounded reviewers independently passed 19 tests (Codex) and 28 tests (Claude), including
  600-asset retention and five-entry traversal-budget stress cases.
- Final `pnpm test` passed 890 files and 5,754 tests; 2 files and 3 tests were skipped.
- `pnpm typecheck`, `git diff --check`, production build, Linux headless/deployment verification,
  and macOS Worker sandbox verification passed during the source review cycle.
- Every modified production TypeScript/TSX file remains below 500 lines.

## Deployment and live acceptance

- Source commit `d88c99febdef8bb5cb49f85260550624174f7f8b` was clean, pushed, and aligned
  with `origin/main` before deployment.
- The official Relay lifecycle upgraded `aws-relay-on-mac` to release `git-d88c99febdef` and
  digest
  `localhost/agent-deck-relay@sha256:35417e052f00c9442c9a81069e7327548402bf277a0a169607d65b27f550af5b`;
  the upgrade and an independent verification both reported healthy.
- The exact-commit macOS package was installed before the official Worker lifecycle upgraded and
  verified `worker-df9dfaddfd410be3979119c7`. The desktop process was not signalled, injected, or
  controlled by the acceptance run.
- An isolated production `SshAgentDeckClient` negotiated protocol 2.2 with authoritative Core
  generation 1 and received all 23 expected capabilities, including Teams, Issues, Usage,
  `node.configuration`, and `node.assets`.
- Sixteen concurrent authority reads completed through the negotiated eight-request Host limit,
  directly exercising the bounded client queue that fixes the reported incompatibility. The probe
  read session totals, Teams, Issues, token usage, provider quota status, Worker defaults, all three
  Worker Hook statuses, the asset list and content, all three application conventions, projects,
  directories, and full Claude/Codex session-create descriptors without Local fallback.
- Worker-owned asset acceptance returned 12 packaged assets, four for each adapter, plus bounded
  content and conventions. Worker-owned Hook status reported user-scope installations for Claude,
  Codex, and Grok.
- Claude session `06fbd0b3-d48d-4b85-bc6d-2106952ecd5d` used
  `deepseek / deepseek-v4-flash[1m] / max` and returned the exact marker
  `CLAUDE_DEEPSEEK_REMOTE_AUTHORITY_OK`.
- Codex session `019ff003-a2bb-7641-ae61-b7e24207da3b` used `gpt-5.6-sol / low` and returned the
  exact marker `CODEX_GPT_5_6_SOL_REMOTE_AUTHORITY_OK`.
- Both sessions reached `active-finished`; the authoritative active session total became 10 and
  Usage exposed post-run `deepseek-v4-flash` and `gpt-5.6-sol` token buckets.

## Explicit residual limitations

- Remote context-window usage snapshots and handoff are not present in the current protocol; the UI
  shows an explicit unavailable chip and disabled handoff action rather than Local data/actions.
- Remote asset injection toggles and application conventions are read-only because they are Worker
  startup configuration; Remote Finder reveal and bundled-agent editing are intentionally absent.
- Image steering during an active Remote Codex/Grok turn remains text-only under the current
  `session.steer` contract; the composer rejects attached images explicitly.
- Asset discovery may be stale for at most five seconds and becomes conservative-truncated when a
  traversal budget is exhausted. Content reads still revalidate the current canonical file.

## Verdict

PASS and live release acceptance complete. Remote pages, settings, Hooks, assets, composer,
attachment policy, and usage surfaces are Core/Worker-authoritative and fail closed. The clean
source release, managed Relay and Worker deployment, 16-request queue acceptance, full authority
surface probe, and real Claude/Codex model sessions all passed without manipulating the desktop
process.
