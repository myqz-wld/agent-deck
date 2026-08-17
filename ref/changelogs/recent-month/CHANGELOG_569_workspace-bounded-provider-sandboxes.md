---
changelog_id: 569
changed_at: 2026-08-08
---

# Workspace-Bounded Provider Sandboxes

## Summary

Compile Remote provider sandbox choices beneath one immutable Workspace ceiling, keep credentials
outside model-facing roots, and make Grok available through a readiness-gated Provider session
container plus Core-owned inference broker.

## Changes

- Added one provider-neutral policy compiler that maps every Remote sandbox request to explicit
  Workspace, selected-directory, runtime-read, and denied private roots. It captures canonical
  directory device/inode/mode/owner identities and revalidates them at the Claude query boundary,
  Codex thread/turn boundary, and provider child startup.
- Mapped Claude `off`, `workspace-write`, and `strict` to Workspace-bounded native filesystem
  policies, while disabling unmanaged hooks, MCP servers, plugin marketplaces, sideload flags, and
  skill shell execution. Mapped Codex modes to fixed named permission profiles that distinguish
  Workspace read-only, selected-directory write, full Workspace write, and network variants.
- Pinned provider `HOME`, config, cache, state, and temp directories to Worker/Core-private roots;
  removed inherited loader/runtime injection; rejected every Remote additional write root; and
  kept provider-native child roots separate from Worker private state.
- Added exact 0600 credential projection for Claude OAuth and Codex auth files only. Projection
  excludes settings, hooks, MCP definitions, plugins, global instructions, SSH files, and arbitrary
  home content; startup refreshes rotations, removes missing credentials, and purges retired Grok
  auth destinations.
- Published honest Core capability results for unsafe combinations. Grok stayed disabled while its
  only implementation was native strict with a readable `$GROK_HOME`; no renderer or runtime path
  silently fell back to Local or a weaker mode. The completed container/broker path now publishes
  Grok and its sandbox choices when both trusted components report ready, and returns the exact
  Core-owned disabled reason only while that runtime is unavailable.
- Pinned that limitation with a real bundled-Grok negative gate using dummy credentials: leaving
  auth readable lets a model-issued file tool recover the canary, while denying the same auth file
  prevents Grok itself from authenticating. The rejected same-process projection and spawn
  overrides were removed rather than weakening the boundary.
- Implemented a Provider session container plus Core-owned credential/inference broker as the
  replacement boundary. The container may receive only its Workspace mount and a session-bound
  broker endpoint, never a reusable provider credential, Worker-private root, SSH identity, engine
  socket, or host-wide filesystem view.
- Added the first testable boundary slice: exact topology-free Provider launch/stop/readiness and
  inference DTOs, a Core-facing supervisor port, a host-private lifecycle supervisor, canonical
  Workspace/state/socket mount authority, and digest-pinned OCI command plans. Public inputs cannot
  carry images, mounts, environment variables, credentials, full URLs, engine sockets, or host paths.
- Added a Core session-bound inference broker that binds instance/process/session/adapter/provider/
  upstream/method/path, applies body/response byte, per-endpoint/global concurrency, and deadline
  limits, cancels on release/close, and delegates real credential ownership to a trusted upstream
  port with no auth field in its request shape.
- Fenced launch/teardown races: close waits for in-flight launches, a launch rechecks lifecycle and
  mount identities around create/start, ambiguous creates clean up only an exact inspected identity,
  replacement fails closed without destructive removal, and broker endpoint identity remains
  reserved until every cancelled in-flight request retires.
- Added the private framed Core-to-host supervisor transport, production Docker Desktop/Colima and
  rootless-Podman command adapter, exact host config/entrypoint, Unix HTTP inference endpoint, and
  trusted HTTPS upstream credential injector. Neither Core nor a Worker sandbox receives an OCI
  engine socket; the Provider container receives no reusable token or credential file.
- Added a bounded attach-stdio ACP/inference multiplexer for the Desktop-VM boundary, where a macOS
  Unix socket cannot be mounted through Colima reliably. The frame protocol limits roles, kinds,
  bytes, concurrency, deadlines, cancellation, and response identity. Rootless Podman retains the
  private mounted Unix socket; both transports drive the same session-bound broker capability.
- Added the fixed Provider shim and digest-pinned Grok image recipe. The shim creates only a local
  loopback inference proxy, writes non-secret mode-0600 Grok configuration, strips model-visible
  authorization/cookie fields, and launches pinned Grok 0.2.118. Docker Desktop uses the outer OCI
  policy as its effective sandbox layer without adding `SYS_ADMIN`; rootless Podman retains the
  provider-native bwrap profiles inside the same Workspace ceiling.
- Kept the broker provider-neutral. Trusted profiles register an exact adapter/provider/upstream,
  path-specific HTTPS origins, allowed paths, credential injector, and limits. The production
  `grok-xai` profile binds exactly xAI Chat Completions and Responses, while the shim answers only
  the fixed local `GET /v1/models` catalog required by pinned Grok. Regression coverage separately
  admits Claude Messages and OpenAI Responses profiles while rejecting cross-profile paths and any
  container-selected origin/header.
- Hardened the reviewed Provider lifecycle: cancelled work retains concurrency and endpoint
  identity until the trusted upstream retires, bounded late cancels are idempotent through retired
  request tombstones, model-facing Claude/Codex processes receive an explicit non-secret
  environment allowlist, and an ambiguously accepted OCI create stays quarantined until exact
  identity reconciliation rather than releasing its mount after one null inspection.
- Added topology-owned provisioning assets for the independently managed Provider supervisor:
  short instance-scoped runtime roots, Linux systemd-user and macOS LaunchAgent templates, packaged
  example configs, health/readiness commands, and static gates. The service still runs outside
  Worker bwrap and the Full Core container; neither receives the OCI engine socket.
- Closed Round 1 Remote parity findings across adjacent boundaries: Core create replay and cleanup,
  path/redaction/result identity, relative Browser leases and owner re-election, renderer
  source/revision/busy fences, and worktree symlink/reference/archive authority. These fixes preserve
  the immutable Workspace ceiling and do not restore a Local fallback.
- Started Remote desktop-broker and SSH transport retirement concurrently during service shutdown,
  preserving aggregate cleanup errors while preventing a blocked broker from delaying local SSH
  cleanup. Classified the request-bound, memory-only Browser response as the sole ephemeral Core
  mutation so its potentially sensitive response body is never admitted to durable replay storage.
- Kept the same semantics across Relay Workers on macOS/Linux and Full: the macOS signed bookmark
  launcher preserves the Workspace selection for provider-native enforcement, Linux runs the
  Worker tree inside its bounded bwrap namespace, and Full retains its read-only container plus
  instance-scoped Workspace/private volumes.

## Validation

- Focused canonical Electron testing passed 7 files and 31 tests across provider policies,
  composition, credential projection, Codex boundaries, and shared Remote creation UI.
- `pnpm typecheck` passed both architecture checks and the Node/web TypeScript projects.
- `pnpm verify:macos-worker-sandbox` built and signed the Worker/provider helpers and passed the
  persistent-bookmark plus outside-Workspace provider canary.
- `pnpm verify:linux-headless` and `deploy/linux/full/static-check.sh` passed the isolated headless
  bundles, bwrap requirement, Full packaging, and provider-auth documentation gates.
- The complete Electron-ABI suite passed 786 files plus one skip and 5,229 tests plus one skip.
  `pnpm build` also passed for main, preload, and renderer production bundles.
- Removed the duplicate capability refresh that followed initial Core adapter selection, preventing
  a transient New Session control disablement; its high-interference regression set and the full
  suite both pass.
- The handoff checkpoint passed `pnpm check:grok-remote-sandbox`, 8 focused files / 33 tests, and
  `pnpm typecheck` including both architecture checks.
- The Provider container/broker boundary passed 9 focused Electron files / 57 tests, repeat boundary
  closure across 5 files / 33 tests, `pnpm typecheck` with both architecture gates,
  `pnpm verify:linux-headless`, `deploy/linux/full/static-check.sh`, `git diff --check`, and the fixed
  Grok negative gate. The line guard also passed after mechanically extracting a 31-line MCP test
  client helper from a pre-existing 507-line integration test.
- Final integration closure passed 830 test files / 5,399 tests with one intentional skip, repeat
  typecheck and both architecture gates, and the main/preload/renderer production build. Focused
  lifecycle and ephemeral-mutation regression runs passed 24 and 11 tests respectively.
- Production transport/shim closure passed 22 focused tests plus both architecture gates and Node/
  web typecheck. The opt-in Colima gate then ran the real pinned Grok 0.2.118 ACP flow through
  `initialize`/authentication, `session/new`, and `session/prompt`; the trusted fake upstream alone
  observed the dummy bearer canary, the request body and inspected container did not, all OCI
  hardening assertions passed, and exact teardown left no test container.
- The expanded opt-in Colima gate passed again with immutable acceptance image
  `sha256:22c027894850e8a5f69154f6d46cb08ac09dc867772cdc8bc9e88f4959c0211e`, assembled from
  the current recipe image and current Provider-session bundle. Real Grok 0.2.118 exercised both
  exact Chat Completions and Responses routes, accepted the actual ACP `allow_once` file-tool
  option, wrote a host-visible Workspace canary, failed against the read-only mount, failed to read
  an adjacent-root canary, exposed no credential/engine socket/auth path, and left zero managed
  containers. Only the deterministic Core fake observed the dummy bearer canary; neither request
  body contained it.
- Post-review Provider validation passed 9 focused files / 37 tests, Node/web typecheck and both
  architecture gates, and the Linux headless bundle build. Every changed ordinary Provider
  TypeScript file remains below 500 lines.
- Final Round 1 fixed-state validation passed the authoritative Electron-ABI suite with 852 files /
  5,489 tests and two intentional file skips / three intentional test skips. Repeat typecheck,
  both architecture gates, production build, Linux headless verification, Full/Relay/Manager/Feishu
  static checks, bundled Grok and its fixed negative gate, and the signed macOS Worker sandbox gate
  all passed. A mechanical pending-hydrator extraction reduced the last renderer source/test pair
  to 495/498 lines; its 7 focused files / 35 tests pass.
- Task 5 pre-review validation passed the authoritative Electron-ABI suite: 847 files and 5,458
  tests passed, with two intentional file/test skips. A whole-suite-only attachment timeout was
  traced to the test stripping `ELECTRON_RUN_AS_NODE` before relaunching `process.execPath`; the
  test-only spawn injection now retains that harness flag without widening the production
  environment allowlist or termination bounds. Focused Electron and ordinary Node runs pass.
- Repeat `pnpm typecheck`, both architecture gates, `pnpm build`, `pnpm verify:linux-headless`, Full
  static checks, `pnpm verify:bundled-runtimes`, and `pnpm verify:macos-worker-sandbox` passed. Three
  oversized touched tests were mechanically reduced through shared fixture extraction; their 42
  focused tests pass and every changed TypeScript/TSX file is now below 500 lines.
- Final local audit retained HEAD `a7bcebc1` and an empty index, found no managed acceptance
  container, and removed only the exact non-secret manual debug-state directory after canonical
  identity and ownership checks. The shared integration tree remains intentionally dirty.

## Evidence Limits

- The macOS gate executes a signed local boundary canary, not a live Remote Claude/Codex session.
  No shared development process was restarted or stopped.
- Linux bwrap, Full Podman/Quadlet/systemd/sshd, and live Feishu/provider execution remain static or
  package evidence in this task; real-host acceptance is owned by the later validation phases.
- macOS Colima Provider-container acceptance is now real, including actual Grok file-tool execution
  and both production protocol paths, but its upstream is a deterministic Core-side fake with a
  dummy canary; it is not a billable live xAI model call or a signed/notarized app distribution
  acceptance.
- Rootless Podman, Full Quadlet/systemd/sshd, Linux Relay Worker, and Feishu execution remain later
  real-host gates. Their static/package contracts do not substitute for those acceptances.
- Runtime availability remains intentionally dynamic: an unprovisioned supervisor, absent pinned
  image, missing/expired broker credential, or unavailable OCI engine disables Grok only. It is not
  a permanent product disablement and does not regress Claude/Codex.

## Do Not Split Protection

All changed ordinary TypeScript and TSX files remain below 500 lines. The Core-visible supervisor
port, host-private OCI/mount types, supervisor lifecycle, command builder, transport, broker ports,
upstream credentials, multiplexer, and provider shim remain separate sibling modules; renderer
sandbox copy stays in the existing `new-session/remote-sandbox-options.ts` helper.
