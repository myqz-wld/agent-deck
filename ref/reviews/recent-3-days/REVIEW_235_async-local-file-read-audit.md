---
review_id: 235
reviewed_at: 2026-08-12
baseline_commit: e876eacdd7735fbf389839fc0361e40a00ba5568
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record, changelog, rebucketing, and index maintenance are mechanical."
---

# REVIEW_235_async-local-file-read-audit: Initial readiness and local-file I/O

## Scope and method

This review traced both user-visible initialization paths and every production or deployment module
that directly performs asynchronous local filesystem reads, plus the higher-level state/config
consumers behind those reads. It distinguished content reads from metadata/identity checks and
classified each call by UI responsiveness, input size, security sequencing, or lifecycle contract.
The review also compared the asynchronous paths with existing synchronous asset/config readers;
the latter are not evidence that latency-sensitive Electron main-process reads should be converted.

```review-scope
scripts/deployment/common.mjs
scripts/deployment/evidence.mjs
scripts/deployment/process.mjs
scripts/deployment/worker-supervisor.mjs
scripts/deployment/worker.mjs
scripts/verify-bundled-grok.mjs
src/hosts/daemon/unix-socket-listener.ts
src/hosts/feishu/trusted-files.ts
src/hosts/instance-manager/adapters/bounded-command.ts
src/hosts/instance-manager/adapters/flock-lease.ts
src/hosts/instance-manager/adapters/linux-filesystem.ts
src/hosts/instance-manager/artifacts.ts
src/hosts/instance-manager/evidence.ts
src/hosts/linux-runtime/atomic-state-file.ts
src/hosts/linux-runtime/config-file.ts
src/hosts/linux-runtime/runtime-module.ts
src/hosts/local-worker/darwin-runtime-module.ts
src/hosts/local-worker/generation-store.ts
src/hosts/provider-session/shim-entrypoint.ts
src/hosts/relay/metadata-file.ts
src/hosts/server-core/mcp-spawn-fork.ts
src/hosts/server-core/mcp-worktree-cleanup.ts
src/hosts/server-core/mcp-worktree-paths.ts
src/hosts/server-core/provider-claude-stream-host.ts
src/hosts/server-core/provider-inference-credential.ts
src/hosts/server-core/session-image-asset.ts
src/main/adapters/claude-code/fork-session-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-host.ts
src/main/adapters/grok-build/history-usage.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/resolve-grok-binary.ts
src/main/adapters/grok-build/resource-store.ts
src/main/adapters/grok-build/turn-queue-helpers.ts
src/main/adapters/grok-build/usage-snapshot.ts
src/main/adapters/session-creation-config-reader.ts
src/main/adapters/session-creation-defaults-core.ts
src/main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps.ts
src/main/agent-deck-mcp/tools/handlers/spawn-fork-preflight.ts
src/main/browser-use/screenshot-store.ts
src/main/browser-use/server.ts
src/main/cli-session-creation.ts
src/main/codex-config/toml-writer.ts
src/main/ipc/images.ts
src/main/ipc/permissions.ts
src/main/permissions/scanner.ts
src/main/permissions/codex-scanner.ts
src/main/store/image-uploads.ts
src/preload/api/adapters.ts
src/preload/api/misc.ts
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/__tests__/SessionDetail.permissions-readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/issues/RemoteIssueResolutionDialog.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/hooks/image-attachments/processing.ts
src/renderer/hooks/useDelayedAsyncFallback.ts
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
src/main/permissions/__tests__/codex-scanner.test.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | New-session model defaults and permission settings are usually fast asynchronous reads, but their unresolved state was rendered as temporary UI. This made the model field and Permissions page visibly jump even though the underlying reads normally finish quickly. | Apply one 150 ms presentation grace: fast reads reveal only their final state, while slower reads receive an explicit loading fallback. Preload Local permissions at detail mount, keep Remote permissions lazy, and start initial defaults without the authoring debounce. |
| LOW | The Codex permission scanner asynchronously read the complete raw `config.toml`, then synchronously reopened it to obtain the top-level model. The two snapshots could disagree, and the raw renderer projection had no byte cap. | Use one asynchronous 256 KiB, 250 ms-bounded snapshot and parse the displayed model from that same text. Oversized/unreadable content returns a path-free terminal error. |
| INFO | Direct asynchronous content reads cover attachments/images, transcripts/history, generated runtime payloads, credentials, configuration, and deployment templates. Metadata reads cover canonical-path, descriptor identity, ownership/mode, executable, worktree, socket, and retention checks. | Retain asynchronous I/O. Several payloads are large or variable, directory traversal is unbounded in count, and the identity-sensitive readers require ordered `open`/`stat`/`read`/`stat` checks without blocking Electron or host service event loops. |
| INFO | A few inputs are normally small: Grok prompt resources, auth/config snapshots, deployment templates, and `.gitignore`. | Retain their promise-based reads because they execute inside already-asynchronous atomic, process, deployment, or remote-host workflows. A synchronous conversion would not simplify the API boundary or the UI and would introduce blocking on slow, network-mounted, or FUSE-backed paths. |

## Async-read disposition

| Category | Representative modules | Decision |
|---|---|---|
| UI configuration | session creation config/default resolvers; Claude and Codex permission scanners | Keep bounded async reads; suppress the first incomplete projection for 150 ms, then show an explicit loading fallback. Codex app-server `config/read`, Remote Core, and renderer IPC are asynchronous regardless of local-file speed. |
| Binary and user assets | Browser `FileReader` uploads, Local/Remote Claude and Grok attachments, image IPC/uploads, Remote image snapshots | Keep async: payloads are variable or large, browser file APIs are asynchronous, and several host readers bind validation and reading to one descriptor. |
| History and discovery | Claude fork transcript discovery, Grok history/usage/recovery, screenshot retention | Keep async: file count and transcript size are not fixed, and these paths must not stall the main/service loop. |
| Trusted runtime state | credentials, Feishu trusted files, atomic state/config, instance-manager filesystem, runtime modules | Keep async: ordered canonical-path, owner/mode, descriptor, and before/after identity checks are part of the trust contract. |
| Worktree and process support | worktree realpath/stat/`.gitignore`, bounded command output, leases, CLI cwd checks | Keep async: these are command/server workflows and may cross user-selected or mounted filesystems. |
| Deployment scripts | deployment config/evidence/process/supervisor and bundled-Grok verification | Keep async: the scripts already compose promise-based process and atomic-write pipelines; synchronous reads offer no user-visible gain. |
| Darwin ESM loader | generated `load()` hook in `darwin-runtime-module.ts` | Keep async: Node's loader hook contract itself is asynchronous. |

No reviewed asynchronous path was a sound candidate for a broad synchronous conversion. The only
read-level correction was removing the duplicate Codex snapshot; the user-visible correction is a
shared delayed-fallback boundary rather than a filesystem API change.

## Validation and evidence

- A repository-wide search covered direct `node:fs/promises`, `fs.promises`, `FileHandle`,
  `createReadStream`, browser `FileReader`, and `Blob.arrayBuffer()` reads in production `src/` and
  deployment/verification `scripts/`, followed by inspection of the relevant callers and
  higher-level filesystem ports.
- Focused new-session and Local/Remote permission grace coverage passed 4 files / 27 tests.
- The complete `pnpm test` suite passed 944 files / 6,052 tests, with 2 files / 3 conditional skips.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.

## Fixes landed

- Local and Remote new-session forms suppress their incomplete first projection for 150 ms, reveal
  final data directly on fast completion, and show an explicit loading shell after the grace; this
  includes both issue-resolution entry points.
- The Local directory explanation appears only in the input placeholder.
- Local permission settings begin loading with Session Detail. Local and Remote permission-tab
  transitions retain the current page during the same grace and show loading only when needed.
- Codex permission projection uses one bounded, internally consistent config snapshot.
- Regression tests cover hidden initial session creation, duplicate-copy removal, deferred Local
  permission-tab presentation, and oversized Codex configuration.

## Residual risk

- Preloading performs a bounded settings scan for every Local Session Detail, even if Permissions is
  never selected. This is an intentional tradeoff: at most four 256 KiB Claude candidates or one
  256 KiB Codex config are read asynchronously so the tab is ready when requested.
- Remote permission data remains lazy because it is Remote Core/network work, but its post-click
  transition follows the same 150 ms grace instead of flashing an immediate loading page.
- No filesystem API can guarantee immediate completion on a stalled mount. Initial session config
  reads have deadlines; after the grace, stalled or genuinely slow reads expose a stable loading
  state instead of preserving the previous view indefinitely.

## Verdict

PASS. The visible jumps were presentation-readiness defects, not a reason to block the main process
with synchronous filesystem calls. The shared 150 ms fallback boundary preserves fast-path visual
stability and honest slow-path feedback. The duplicate Codex read was removed, all remaining
asynchronous local reads have a concrete responsiveness, size, security, or lifecycle justification,
and all validation gates passed.
