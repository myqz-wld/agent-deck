---
review_id: 262
reviewed_at: 2026-08-24
baseline_commit: e4482dd584f5afddd19fdd0a67d159eb1927566f
related_changelog: CHANGELOG_628
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, changelog, review, bucket moves, and indexes are final mechanical records."
---

# REVIEW_262_native-project-trust: Native project trust security and lifecycle review

## Scope and method

This local review covered the complete provider-native trust implementation, public/private schema
bumps, Desktop and Remote create ordering, Grok container projection, UI consent identity, and the
focused regression set. It compared behavior against the approved Pi/trust plan and the native
Claude/Codex/Grok semantics established by its spikes. The plan explicitly prohibited sub-agent
delegation, so no independent reviewer session was used.

The repository review-expiry report was run before finalization. This record covers every changed
source/test path below; final records and mechanical rebucketing are excluded in frontmatter.

```review-scope
src/contracts/issues.test.ts
src/contracts/project-trust.ts
src/contracts/provider-session-container.test.ts
src/contracts/provider-session-container.ts
src/contracts/session-console-capabilities.fixture.ts
src/contracts/session-console-capabilities.ts
src/contracts/session-console.test.ts
src/contracts/session-console.ts
src/core/session-console.test.ts
src/gateways/im/audit-validation.test.ts
src/gateways/im/command-executor.ts
src/gateways/im/gateway.test.ts
src/hosts/provider-session/live-colima-acceptance.test.ts
src/hosts/provider-session/node-mounts.test.ts
src/hosts/provider-session/node-oci.test.ts
src/hosts/provider-session/oci-command.test.ts
src/hosts/provider-session/oci-command.ts
src/hosts/provider-session/shim-entrypoint.test.ts
src/hosts/provider-session/shim-entrypoint.ts
src/hosts/provider-session/supervisor-transport.test.ts
src/hosts/provider-session/supervisor.test.ts
src/hosts/server-core/issue-runtime.test.ts
src/hosts/server-core/mcp-handoff-target.ts
src/hosts/server-core/mcp-session-spawn-agent-capabilities.test.ts
src/hosts/server-core/mcp-session-spawn.ts
src/hosts/server-core/project-trust.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-grok-container-production.test.ts
src/hosts/server-core/provider-grok-container-production.ts
src/hosts/server-core/provider-grok-container-runtime.test.ts
src/hosts/server-core/provider-grok-container-runtime.ts
src/hosts/server-core/provider-grok-container-transport.test.ts
src/hosts/server-core/provider-grok-container-transport.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-provider-container.ts
src/hosts/server-core/session-console-authority.test.ts
src/hosts/server-core/session-console-authority.ts
src/hosts/server-core/session-create-capabilities.test.ts
src/hosts/server-core/session-create-capabilities.ts
src/main/adapters/grok-build/__tests__/launch-child.test.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/launch-child.ts
src/main/adapters/project-trust/claude.test.ts
src/main/adapters/project-trust/claude.ts
src/main/adapters/project-trust/codex.test.ts
src/main/adapters/project-trust/codex.ts
src/main/adapters/project-trust/core.test.ts
src/main/adapters/project-trust/core.ts
src/main/adapters/project-trust/desktop.ts
src/main/adapters/project-trust/grok.test.ts
src/main/adapters/project-trust/grok.ts
src/main/adapters/project-trust/project-paths.ts
src/main/adapters/project-trust/secure-state-file.ts
src/main/adapters/session-creation-defaults.ts
src/main/ipc/__tests__/adapters-outgoing.test.ts
src/main/ipc/__tests__/issues-resolution-create.test.ts
src/main/ipc/adapters.ts
src/main/ipc/issue-resolution-session.ts
src/main/ipc/issues.ts
src/main/remote-host/input-validation-issues.test.ts
src/main/remote-host/input-validation-issues.ts
src/main/remote-host/input-validation.test.ts
src/main/remote-host/input-validation.ts
src/main/remote-host/service-issues.test.ts
src/main/remote-host/service-issues.ts
src/main/remote-host/service-session-console.ts
src/main/remote-host/service.test.ts
src/preload/api/adapters.ts
src/preload/api/issues.ts
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/__tests__/NewSessionDialog.project-trust.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/issues/RemoteIssueResolutionDialog.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/session-dialog-actions.ts
src/renderer/components/new-session/useRemoteSessionCreation.test.tsx
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/hooks/__tests__/useSessionCreationOptions.test.tsx
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/remote-host/remote-intent-ledger.test.ts
src/renderer/remote-host/source-types.ts
src/shared/remote-host/types.ts
src/shared/types.ts
src/shared/types/project-trust.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | A Local adapter switch could retain the prior checked consent during the 150 ms presentation grace even though the underlying request identity had changed. | Bind the displayed checkbox value and setter to the current authoring identity while retaining only the read-only prior descriptor; add a regression that proves it clears and disables immediately. |
| MEDIUM | Generic native trust conflicts in Server Core could escape as internal errors, obscuring a stale descriptor from Remote clients. | Map stale/current conflicts to `conflict` and verified-grant failures to `capability_unavailable`, with bounded path-free messages and focused tests. |
| MEDIUM | The secure state reader checked size before `readFileSync`, so a concurrent grow could allocate beyond the one-MiB bound; writers also lacked a final output-size gate. | Replace it with an observed-size-plus-one sentinel loop, recheck file identity/size, and reject oversized output before creating a temporary file. |
| MEDIUM | Claude JSON with a structurally invalid `projects` map or project entry could be treated as empty and then normalized by a grant. | Validate the native map/entry/trust flag shape and return `state-malformed` without exposing a grant or writing state. |
| LOW | A Grok store key such as `<home>/child/..` could evade the literal home-root check. | Normalize absolute roots before comparing home/filesystem root and add a disguised-root regression. |
| LOW | The first complete suite still contained six schema-v1 fixture expectations after the coordinated public contract bump. | Update Issue and Feishu fixtures to include the exact no-grant trust request; the next two complete suites passed. |

## Validation and evidence

- Pure provider coverage exercises deterministic revisions, stale/idempotent transitions,
  verification failure, Claude latest-read preservation and unsafe files, Codex exact/project/main
  precedence plus native versioned writes, and Grok ancestor/deny/policy/root/native-store behavior.
- IPC/Core tests prove validation precedes mutation, trust precedes attachments/provider startup,
  a later failure retains trust, stale Remote state maps to conflict, and public results omit paths.
- Renderer tests prove provider-specific Chinese copy, unchecked default, current revision submission,
  adapter/provider/cwd/source/open-cycle reset, diagnostic-only creation, and prompt/image retention.
- Private provider-session tests prove both boolean states, schema-v2 rejection, OCI projection, and
  native Grok `--trust` argv on Desktop and container paths.
- `pnpm typecheck` passed architecture, Core Node, and TypeScript checks.
- Final complete `pnpm test`: 1,007 files and 6,307 tests passed; 2 files and 3 opt-in tests skipped.
- `pnpm build`, `pnpm logger:check`, `bash scripts/file-level-review-expiry.sh`, and
  `git diff --check` passed.
- Every changed production TypeScript file is at or below 500 lines after extracting the focused
  project-trust contract and Server Core composition modules.

## Residual risk

- Claude's state field and lock convention are native implementation details rather than a stable
  public API. Drift fails to `unknown`/no-checkbox and leaves creation under Claude's own behavior;
  it does not authorize or rewrite an unrecognized store.
- Codex app-server and Grok trust-store formats remain provider-owned. Exact schema/version tests
  and post-write verification bound failure, but a future provider release can make grants
  unavailable until Agent Deck is updated.
- Public and private schema version 2 require a coordinated Desktop/Core/Worker/provider-session
  release; mixed versions intentionally fail instead of silently dropping consent.
- Live development-process acceptance remains user-owned; no further process stop/start is part of
  this delivery after the explicit no-process-mutation direction.
- The Pi adapter is design-only. Its binary packaging, RPC fixtures, MCP extension channel, Remote
  runtime, permissions, and sandbox still require their staged future implementation.

## Verdict

PASS. No open CRITICAL, HIGH, MEDIUM, or LOW finding remains in the reviewed scope. The user-owned
trust persistence and failure choices are implemented without conflating project trust, tool
approval, or OS sandbox authority.
