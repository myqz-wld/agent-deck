# Remote project scan — 2026-09-04

- Invocation: `2026-09-04-project-scan`; ordinary independent scan, with no review skill or recursive delegation.
- Baseline and inspected HEAD: `072dd7a284eebc2752dab7e5d5505aa2ee480b77` (`main`). The tracked worktree was clean at entry and remained clean after validation.
- Primary inventory: `ref/reviews/recent-3-days/project-code-quality-scan-evidence/scopes/remote-scope.txt`: 726 tracked files / 121,495 lines; 256 test files and 470 other source/support files. The latter count includes active test fixtures and is not a production-module count.
- Read-only source/Git scan. All evidence files are under `/tmp/agent-deck-scan/2026-09-04-project-scan/remote/`. No live credentials, databases, provider transcripts, unrelated sessions, service processes, or installed applications were accessed or changed.
- Read `CLAUDE.md`, `AGENTS.md`, packaged Codex/Claude conventions, the invocation plan, and `ref/reviews/recent-3-days/REVIEW_267_compatibility-dead-code-audit.md`. Findings below refer to existing HEAD code, not deleted compatibility paths.

## Findings

| ID | Severity | Confidence | Current supported-path defect |
| --- | --- | --- | --- |
| remote-01 | HIGH | High; isolated production-path reproduction | Default Relay resets valid large event responses before credit can return. |
| remote-02 | MEDIUM | High; isolated Core-to-gateway reproduction | Normal line breaks invalidate Feishu history and ordinary inbound messages. |
| remote-03 | MEDIUM | High; installed SDK dispatcher plus gateway reproduction | Group bot mention prefixes turn slash commands into provider messages. |

No confirmed trust-boundary bypass is reported. The two Feishu issues are normal authorized-user functional failures, not an allegation that an unpaired user can acquire owner authority.

### remote-01 — Valid Remote activity responses exceed a synchronous Relay bridge's actual capacity

**Primary location:** `src/hosts/local-worker/frame-bridge.ts:278`. Related production anchors: `src/hosts/local-worker/frame-bridge.ts:46`, `src/hosts/local-worker/frame-bridge.ts:258`, `src/hosts/local-worker/daemon-frame-channels.ts:43`, `src/hosts/daemon/frame-writer.ts:132`, `src/contracts/session-events.ts:6`.

```ts
      nextStreamBytes > this.limits.maxOutputQueueBytesPerStream ||
      nextTotalBytes > this.limits.maxOutputQueueBytesTotal ||
      nextStreamFrames > this.limits.maxOutputQueueFramesPerStream ||
      nextTotalFrames > this.limits.maxOutputQueueFramesTotal
    ) {
      this.fail(stream, 'backpressure');
```

**Trigger and consequence.** Open a Relay-backed session whose normal activity page contains about 1 MiB of projected events. This is within the supported 3 MiB event response and 4 MiB daemon frame contracts. The real daemon writer submits the entire encoded response to `RelayDaemonStream._write`. That method synchronously calls `output.data`, and `LocalWorkerFrameBridge.onCoreData` synchronously loops over all 64 KiB chunks. Only 256 KiB of initial outbound credit exists, with 512 KiB of per-stream buffering. Once these are exhausted, the bridge resets the Core stream. Network credit cannot arrive in the same synchronous loop. Even an otherwise healthy client therefore cannot receive one accepted response above the bridge's remaining credit plus queue capacity. The activity view fails and its SSH/Core connection must recover; retrying the same large page repeats the condition.

**Production chain.** `src/renderer/remote-host/use-remote-event-records.ts:45` requests `SESSION_EVENT_MAX_ITEMS` through the Remote preload/IPC facade → `RemoteHostDetailReader.listEvents` → `requestRemoteEvents` (`src/main/remote-host/service-session-detail.ts:59`) → SSH/Relay → `ServerCoreSessionDetailRuntime.listEvents` (`src/hosts/server-core/session-detail-runtime.ts:245`) → `projectSessionEvents` → daemon frame writer → `RelayDaemonStream._write` → bridge `onCoreData` / `bufferCoreChunk`. Worker composition selects this exact daemon channel factory in `src/hosts/local-worker/runtime-composition.ts:50`; `negotiatedBridgeLimits` retains the default queue ceilings (`src/hosts/local-worker/attachment-validation.ts:139`).

**Verification.** `repro.test.ts`, test `default Relay transport resets a valid 1 MiB event-list response before credit can return`, uses 100 ordinary assistant events with 10 KiB text each, the real event projector/result validator, real daemon handshake/request processing, real Worker daemon channels, and default bridge limits. The resulting valid response is **1,037,404 bytes**. After a successful hello the bridge emits only **196,608 response bytes**, then emits `reset/backpressure` and removes the stream. No socket, actual provider, server, or credential was used.

**Counter-evidence checked.** Image assets already use chunked reads; they are not the example for this finding. The bridge already fragments output above initial credit, and `src/hosts/local-worker/frame-bridge.test.ts:138` passes, but that test's entire payload fits initial credit plus its output queue. Fragmenting a larger synchronous frame does not itself make the producer wait. This report does not infer a problem solely from a configurable queue threshold or an unsupported traffic scale.

**Fix direction / architecture cost.** Let the daemon writer wait for downstream capacity while progressively handing off one frame, or provide an explicitly bounded, shared response/chunk contract that every producer satisfies. Retain bounded memory and generation fencing. Today the response contract, daemon frame allowance, and synchronous Worker queue budget have separate owners and disagree in a supported workflow. Add a real daemon-to-bridge contract test above initial-credit-plus-queue capacity. Choosing a smaller product response/page ceiling versus transport backpressure is an architecture decision; simply raising a queue without reconciling the complete frame contract is incomplete.

### remote-02 — Feishu treats ordinary text line breaks as invalid control data

**Primary location:** `src/gateways/im/core-bounds.ts:37`. Related anchors: `src/gateways/feishu/mapper.ts:16`, `src/gateways/feishu/mapper.ts:201`, `src/gateways/im/validation.ts:195`, `src/hosts/server-core/runtime-history.ts:20`.

```ts
    if (typeof item === 'string') {
      if (
        new TextEncoder().encode(item).byteLength > limits.maxCoreFieldBytes ||
        CONTROL.test(item)
      ) {
        fail(field);
```

**Trigger and consequence.** An ordinary assistant response contains `First line\nSecond line`; the enrolled user requests `/history` in a private Feishu chat. `serverCoreHistoryEntry` preserves the text, but the gateway recursively applies a control-character expression covering all U+0000–U+001F characters to every Core string. The newline rejects the whole history page as `invalid_core_response`. The message callback returns an internal acknowledgement with that code and produces no Feishu reply. A plain multiline inbound prompt similarly fails the mapper as `invalid_event`; `/send` also encounters a second newline-rejecting text validator. Multiline command previews/questions in Core pending displays are exposed to the same generic response gate; that extension was traced statically, not separately exercised.

**Production chain.** Feishu WS SDK → `FeishuSdkEventAdapter.onMessage` → gateway → `/history` branch at `src/gateways/im/command-executor.ts:249` → `session.history` in `src/hosts/server-core/runtime-core.ts:215` / `serverCoreHistoryEntry` → `validateHistoryResult` (`src/gateways/im/core-output.ts:245`) → `assertBoundedCoreValue`. On rejection the gateway returns its acknowledgement (`src/gateways/im/gateway.ts:313`), while `onMessage` ignores its result (`src/gateways/feishu/event-adapter.ts:32`). Both Full and Relay use this same Feishu path.

**Verification.** `repro.test.ts`, test `one normal multiline history entry rejects Feishu /history`, passes the real `serverCoreHistoryEntry` output into the normal gateway with fixture transport/client ports: result **`invalid_core_response`**, **zero replies**. The same test invokes the installed official SDK's `EventDispatcher` and real mapper on a two-line inbound message: **`invalid_event`**. Baseline mapper tests pass but contain no multiline text case.

**Counter-evidence checked.** Existing tests intentionally reject NUL and malformed identifiers (`src/gateways/im/security-and-delivery.test.ts:71`), which should remain rejected. There is no source evidence here of a product decision to prohibit ordinary text newlines. The outbound redactor explicitly preserves TAB/LF/CR (`src/gateways/im/redaction.ts:4`), and `/send` / `/create` command expressions allow multiline payload shapes, so these current text checks disagree.

**Fix direction / architecture cost.** Keep strict identifier validation while allowing bounded LF/CR/TAB in human text values. Reuse one explicit text policy across the mapper, command validator, and Core response validator, retaining byte/depth/node limits and secret redaction. The existing duplicated control filters currently disagree with the text renderer and valid Core outputs. No authority or compatibility policy needs relaxing. If single-line-only Feishu is actually desired, that is a user-owned product restriction that must be made explicit rather than inferred from this regex.

### remote-03 — A Feishu group bot mention changes command semantics

**Primary locations:** `src/gateways/feishu/mapper.ts:201`, `src/gateways/im/commands.ts:49`.

```ts
  const input = bounded.trim();
  if (input.length === 0) {
    throw new FeishuGatewayError('invalid_command', '消息不能为空');
  }
  if (!input.startsWith('/')) return { kind: 'send', text: bounded };
  if (input === '/help') return { kind: 'help' };
```

**Trigger and consequence.** An enrolled user addresses the bot in a group with `@Agent Deck /select session-1` or `/unsubscribe`. Feishu message content represents the mention as `@_user_1` with a corresponding entry in `message.mentions`. The mapper validates that array but does not remove/resolve the bot mention before passing `content.text` to the command parser. `@_user_1 /select session-1` is classified as a normal send and fails `session_not_selected` in a fresh group. If the group already has a selected session, `@_user_1 /unsubscribe` becomes a **`session.send` mutation containing the command text**; no `subscription.set` call occurs. Thus ordinary mention-addressed commands either fail or unexpectedly enter the model conversation.

**Production chain.** `src/gateways/feishu/sdk.ts:96` registers the installed SDK dispatcher → `FeishuSdkEventAdapter.onMessage` → `mapFeishuMessageEvent` (`validateMentions` at line 182 only validates) → `FeishuSessionConsoleGateway.executeMessage` → `parseFeishuCommand` → `FeishuCommandExecutor.execute` send branch at `src/gateways/im/command-executor.ts:275`.

**Verification.** `repro.test.ts`, test `SDK group bot mention turns /unsubscribe into session.send`, uses the installed `@larksuiteoapi/node-sdk` 1.73.3 `EventDispatcher.invoke` locally, with a schema-2 event carrying a mention placeholder and mention identity. Its output goes through the real mapper and gateway. Results: fresh mention-addressed select gives `session_not_selected`; an already selected group accepts the unsubscribe text as `session.send`; **zero `subscription.set` calls**. Authentication checks are bypassed only inside this offline SDK-dispatch fixture because no network request is involved; gateway credential matching still uses its ordinary enrolled fixture credential.

**Counter-evidence checked.** The pinned SDK preserves raw message content in this low-level dispatcher. Its separate normalization implementation explicitly handles mention placeholders (`node_modules/@larksuiteoapi/node-sdk/lib/index.js:106522`); Agent Deck does not use that normalizer. The repository mapper fixture has a mention array but an already bare `/sessions` body (`src/gateways/feishu/mapper-transport.test.ts:40`), so its passing test misses the combined real shape. Group egress redaction is intentional and unrelated; it does not resolve the command prefix.

**Fix direction / product decision.** Identify the configured bot's stable open-id and remove only its addressed prefix before command classification, or use an equivalently bounded SDK normalization stage. Preserve other user mentions/content, app/tenant/open-id matching, and group redaction. Broadening group visibility is not required. If product intent is that commands only work in private chats, explicitly reject group commands and change the advertised group behavior; the current implementation otherwise attempts to support them.

## Validation

- `pnpm run test --config /tmp/agent-deck-scan/2026-09-04-project-scan/remote/scan.config.mjs --no-cache --reporter=verbose`: **3 / 3 isolated reproductions passed**. These assertions confirm the existing faulty behavior; they are not a claim that the defects were fixed. `repro-result.txt` contains the measured outcomes.
- `pnpm run test --config /tmp/agent-deck-scan/2026-09-04-project-scan/remote/focused.config.mjs --no-cache --reporter=dot`: **6 files / 41 existing tests passed**. Files: Worker frame bridge, Feishu mapper/transport, official SDK wrapper, IM stream generation, provider-session multiplex, private bridge admission. See `focused-result.txt`.
- Both runs used the repository `scripts/test-electron.mjs` wrapper, one worker, cache redirected/disabled, and existing in-memory/stream test seams. No SQLite binding rebuild or native install was needed. The selected existing tests use fake provider/SSH/transport ports and in-memory streams; no actual host/remote listener was started.
- An initial `pnpm test --config ...` invocation was rejected by pnpm option parsing; `pnpm run test ...` correctly forwarded the options to the existing wrapper. It did not run a test or alter source.
- Typecheck, whole-suite execution, package/build verification, and deployment tests are lead-owned and are not claimed by this worker.

## Compatibility and unused-code classification

| Classification | Current evidence / disposition |
| --- | --- |
| Confirmed dead production code | None established in this bounded scan; do not infer absence across all 726 files. |
| Candidate dead / test-only | `InMemoryFeishuGatewayStore` and its delete-confirmation helper are reachable through the IM barrel but used by active test fixtures. Keep them as test support; relocating them is optional organization, not a proven production defect or justified deletion. |
| Necessary current boundary | Server Core Browser MCP registration remains live in `src/hosts/server-core/mcp-server.ts:36` and `src/hosts/server-core/mcp-browser-tools.ts:98`; desktop/CLI mapping still uses the legacy-named operation table. Those names do not prove an obsolete path. |
| Necessary recovery | Current provider-home projection removes stale retired Grok credentials, and the instance manager retains durable rollback/journal recovery. They must not be deleted merely because their names mention retirement/recovery. |
| Explicit tested behavior | Notification queue/protocol faults fence the current generation and replay after a later chat command. `src/gateways/im/audit-resync-shutdown.test.ts:90` deliberately requires that flow. This was excluded as an automatic-reconnect defect. |
| External/deployment boundary | Bridge admission requires current v2 vocabulary and rejects v1 in an active test. Provider `*-v1` names and protocol version checks remain current contracts. |

Searches covered compatibility/fallback/legacy/deprecated markers in every primary file, module registration and imports around the traced flows, MCP registrations, and Full/Relay/Worker/provider-session/Feishu production compositions. The broader repository production-entrypoint graph and packaging roots remain the lead's integrated check. No deletion recommendation relies on a barrel appearing reachable or a symbol lacking one literal search result.

## Coverage and limitations

`inventory.txt` preserves the exact assigned 726-file inventory. `static-scan.json` records per-file LOC and marker matches for compatibility, dynamic/registration entrypoints, and lifecycle/boundary/queue constructs across all 726 files. This is pattern-level breadth, not exhaustive semantic validation. `direct-inspected-files.txt` lists 108 assigned source/test files actually opened in full or in focused excerpts; `inspected.tsv` records requested read ranges, which must not be interpreted as line-by-line coverage (some long terminal output was truncated).

Traced workflows:

1. SSH hello identity/topology/scope checks, connection attempts and retirement, heartbeat, pending requests, re-admission, response deduplication, subscription cursors and terminal errors.
2. Full daemon admission, authenticated method grants, request/cancellation/deadline scheduling, result framing, subscription forwarding and teardown.
3. Relay credential/surface/generation checks, stream ownership, worker attachment, heartbeat/fencing, per-direction credit, bounded queues, large response delivery, and Core channel composition.
4. Desktop Remote source epochs and expected authority, profile retirement/import material capture, resource change notifications and event reads; UI/preload imports were followed only for context.
5. Feishu SDK event mapping, pairing entry, nonce-bound pending responses, command execution, transport idempotency, delivery ledger coordination, notification lanes/client epochs, and shutdown; actual credentials/SQLite stores were not opened.
6. Provider-session launch/stop identity fencing and teardown structure, production supervisor composition, ACP/inference/Browser multiplexing, Grok container mapping, and provider runtime startup/shutdown ordering.
7. Representative appliance/workspace policy construction, provider-home projection, instance-manager lifecycle/recovery, and server-control credential rotation/issuance transaction structure (source only).

Remaining gaps: most Server Core MCP worktree/handoff/issue/task implementations and their persistent-state races were inventoried/searched but not deeply traced; only representative instance-manager/server-control paths were read; real kernel/OCI/mount/SSH/network behavior and packaged runtime startup were not exercised. Provider startup and disposal paths were source-traced, not validated with a live provider. Live Feishu event retries/permissions/platform behavior were not exercised; the SDK-shape reproduction uses the installed public implementation and synthetic valid event objects. Windows behavior, production throughput and load, and credential rotation crash recovery were not dynamically tested. No finding depends on these untested scenarios.

There is no open access blocker. Source fixes remain outside this scan's authorization. The three findings can be independently reproduced using the supplied temporary test files, and no live runtime restart is needed to review the evidence.

## Directly opened assigned files

The following list is exact at report completion; depth varies by the workflows and gaps above.

```text
src/clients/ssh/client.ts
src/clients/ssh/connection-attempt.ts
src/clients/ssh/connection-message-router.ts
src/clients/ssh/connection.ts
src/clients/ssh/frame-writer.ts
src/clients/ssh/handshake.ts
src/clients/ssh/pending-request.ts
src/gateways/feishu/action-envelope.ts
src/gateways/feishu/event-adapter.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/mapper.ts
src/gateways/feishu/nonce.ts
src/gateways/feishu/pairing-event-handler.ts
src/gateways/feishu/runtime.ts
src/gateways/feishu/sdk.test.ts
src/gateways/feishu/sdk.ts
src/gateways/feishu/source-registry.ts
src/gateways/feishu/transport.ts
src/gateways/im/__tests__/fixture.ts
src/gateways/im/audit-resync-shutdown.test.ts
src/gateways/im/audit-stream-generation.test.ts
src/gateways/im/callback-attempt.ts
src/gateways/im/client-pool.ts
src/gateways/im/command-executor.ts
src/gateways/im/commands.ts
src/gateways/im/core-bounds.ts
src/gateways/im/core-output.ts
src/gateways/im/delivery.ts
src/gateways/im/gateway-binding.ts
src/gateways/im/gateway.ts
src/gateways/im/index.ts
src/gateways/im/notification-delivery.ts
src/gateways/im/notification-lanes.ts
src/gateways/im/pending-action.ts
src/gateways/im/redaction.ts
src/gateways/im/security-and-delivery.test.ts
src/gateways/im/subscription-events.ts
src/gateways/im/validation.ts
src/hosts/appliance/policy.ts
src/hosts/daemon/connection-handshake.ts
src/hosts/daemon/connection-messages.ts
src/hosts/daemon/connection-test-helpers.ts
src/hosts/daemon/connection.ts
src/hosts/daemon/frame-writer.ts
src/hosts/daemon/request-scheduler.ts
src/hosts/daemon/ssh-bridge-listener.ts
src/hosts/daemon/types.ts
src/hosts/feishu/client-factory.ts
src/hosts/feishu/entrypoint.ts
src/hosts/instance-manager/adapters/bounded-command.ts
src/hosts/instance-manager/lifecycle.ts
src/hosts/instance-manager/recovery.ts
src/hosts/linux-runtime/service-runner.ts
src/hosts/local-worker/attachment-validation.ts
src/hosts/local-worker/attachment.ts
src/hosts/local-worker/daemon-frame-channels.ts
src/hosts/local-worker/frame-bridge-chunking.ts
src/hosts/local-worker/frame-bridge.test.ts
src/hosts/local-worker/frame-bridge.ts
src/hosts/local-worker/runtime-composition.ts
src/hosts/provider-session/browser-runtime.ts
src/hosts/provider-session/multiplex.test.ts
src/hosts/provider-session/multiplex.ts
src/hosts/provider-session/production.ts
src/hosts/provider-session/supervisor.ts
src/hosts/provider-state/provider-home-projection.ts
src/hosts/relay/bounded-queue.ts
src/hosts/relay/credential-authority.ts
src/hosts/relay/credential-policy.ts
src/hosts/relay/router-terminal.ts
src/hosts/relay/router-types.ts
src/hosts/relay/router.ts
src/hosts/relay/worker-delivery.ts
src/hosts/server-control/connection-service.ts
src/hosts/server-control/feishu-rotation.ts
src/hosts/server-core/browser-cli-executor.ts
src/hosts/server-core/credential-file.ts
src/hosts/server-core/mcp-browser-tools.ts
src/hosts/server-core/mcp-server.ts
src/hosts/server-core/provider-grok-container-production.ts
src/hosts/server-core/provider-grok-container-runtime.ts
src/hosts/server-core/provider-grok-container-transport.ts
src/hosts/server-core/provider-runtime-lifecycle.ts
src/hosts/server-core/remote-safe-file-read.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-core.ts
src/hosts/server-core/runtime-history.ts
src/hosts/server-core/runtime-mutation-ledger.ts
src/hosts/server-core/runtime-mutation.ts
src/hosts/server-core/runtime-provider-retirement.ts
src/hosts/server-core/session-detail-runtime.ts
src/hosts/server-core/session-event-projection.ts
src/hosts/server-core/session-file-path-authority.ts
src/hosts/server-core/session-image-asset.ts
src/hosts/ssh-bridge/tunnel.ts
src/hosts/workspace-sandbox/launch-policy.ts
src/main/remote-host/business-validation.ts
src/main/remote-host/connection-selections.ts
src/main/remote-host/event-bridge.ts
src/main/remote-host/input-validation-session-detail.ts
src/main/remote-host/profile-controller.ts
src/main/remote-host/service-request-authority.ts
src/main/remote-host/service-scope.ts
src/main/remote-host/service-session-detail.ts
src/main/remote-host/service-snapshot.ts
src/main/remote-host/service.ts
src/protocol/bridge-admission.test.ts
src/protocol/bridge-admission.ts
```

Additional context reads are listed in `context-inspected-files.txt`; required repository/convention documents and package/test configuration were also read.
