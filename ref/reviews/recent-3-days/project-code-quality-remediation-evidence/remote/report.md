# Remote implementation evidence

Captured at worker handoff and accepted by the lead. Subsequent global validation and fixture-only corrections are recorded in REVIEW_269. The pending lead actions in the original handoff below are historical.

## Worker results

Status: **ready-for-review**.

Implemented remote-01, remote-02 and remote-03 within the authorized write set. No source expansion, dependency change, Git index/ref operation, recursive delegation or live runtime action was needed.

### Implementation and decisions

- **remote-01:** `CoreFrameOutput` now publishes a negotiated `maxChunkBytes` and an awaited admission result. `RelayDaemonStream` feeds one bounded chunk at a time and completes its Node write callback only after the full encoded frame has been admitted. This lets the existing daemon writer retain its byte accounting for the original response while bridge capacity is exhausted. Bridge per-stream/global byte and frame queue ceilings are unchanged; each blocked stream has at most one admission waiter. Credit or released global capacity resumes waiters, and reset/dispose settles them against the original stream object. Chunk sizing includes the route envelope and the per-stream queue size, so smaller negotiated route frames still carry the advertised 4 MiB Core body plus its four-byte prefix. No 3 MiB event contract was reduced.
- The daemon write-progress deadline now observes admitted chunks as well as ordinary callbacks/drain. A slowly advancing frame can exceed ten seconds in total without being mistaken for a stalled write. A real ten-second stall still terminates it; destroying an incomplete frame resets the route instead of leaving an undrainable/truncated prefix behind a graceful close. Graceful close after complete admitted output, stream generation/identity checks, cancellation, and independent streams remain covered.
- **remote-02:** One explicit text policy now distinguishes TAB/LF/CR in human text from strict control-data checks. The mapper, command text validator, recursive Core value checks and redactor share it. Identifier tokens, JSON keys, field/response UTF-8 byte limits, depth/node/cycle bounds, credential ownership and redaction retain their checks. Existing single-line display/control metadata stays strict.
- **remote-03:** Before the SDK connection starts delivering events, the production runtime resolves the configured app's bot open-id through its existing authenticated official SDK `Client.request` boundary (`GET /open-apis/bot/v3/info`, the same path used by the installed SDK's own identity resolver). The HTTP request uses the existing startup timeout; the long-connection startup deadline still governs readiness. Lookup failures stay sanitized and prevent startup, and a late lookup cannot open a connection after close. No new user configuration is introduced. The mapper removes only a leading, placeholder-delimited mention whose open-id matches that bot and whose optional tenant matches the pinned tenant. Other mentions, embedded mentions, private text/commands and group egress redaction stay intact; ambiguous duplicate placeholders are rejected.
- Extracted bridge types/defaults/limit assertions into `frame-bridge-types.ts`, retaining the existing `frame-bridge.ts` exports. All 19 changed/new source and test files are below 500 lines; no file-size exception is needed.

### Exact changed source/test paths

- `src/gateways/feishu/bot-identity.test.ts`
- `src/gateways/feishu/mapper.ts`
- `src/gateways/feishu/message-semantics.test.ts`
- `src/gateways/feishu/runtime.ts`
- `src/gateways/feishu/sdk.ts`
- `src/gateways/im/core-bounds.ts`
- `src/gateways/im/redaction.ts`
- `src/gateways/im/text-policy.test.ts`
- `src/gateways/im/text-policy.ts`
- `src/gateways/im/validation.ts`
- `src/hosts/daemon/frame-writer.ts`
- `src/hosts/daemon/types.ts`
- `src/hosts/local-worker/daemon-frame-channels.test.ts`
- `src/hosts/local-worker/daemon-frame-channels.ts`
- `src/hosts/local-worker/frame-bridge-types.ts`
- `src/hosts/local-worker/frame-bridge.test.ts`
- `src/hosts/local-worker/frame-bridge.ts`
- `src/hosts/local-worker/frame-output-waiters.test.ts`
- `src/hosts/local-worker/relay-output-capacity.test.ts`

### Validation

Final focused run: **33 files / 256 tests passed**, exit 0, with the existing Electron-compatible wrapper, one worker and no test cache. This includes 43 new permanent regression cases in five new test files, along with existing daemon backpressure/identifier, Worker attachment/retirement, complete IM security/delivery/lifecycle and relevant Feishu SDK/mapper/runtime suites.

```sh
pnpm run test src/hosts/local-worker/frame-bridge.test.ts src/hosts/local-worker/daemon-frame-channels.test.ts src/hosts/local-worker/relay-output-capacity.test.ts src/hosts/local-worker/frame-output-waiters.test.ts src/hosts/local-worker/attachment.test.ts src/hosts/local-worker/attachment-retirement.test.ts src/hosts/daemon/frame-writer.test.ts src/hosts/daemon/connection.test.ts src/hosts/daemon/connection-backpressure.test.ts src/hosts/daemon/connection-identifiers.test.ts src/gateways/im src/gateways/feishu/message-semantics.test.ts src/gateways/feishu/bot-identity.test.ts src/gateways/feishu/mapper-transport.test.ts src/gateways/feishu/sdk.test.ts src/gateways/feishu/event-adapter.test.ts src/gateways/feishu/runtime-shutdown.test.ts src/gateways/feishu/health.test.ts --maxWorkers=1 --minWorkers=1 --no-cache --reporter=dot
pnpm exec tsc --pretty false --noEmit -p ref/reviews/recent-3-days/project-code-quality-remediation-evidence/remote/tsconfig.json
git diff --check -- src/gateways src/hosts/local-worker src/hosts/daemon src/hosts/feishu
```

- The scoped TypeScript check exited 0 with no diagnostics. Its disposable config extends the repository Node config, selects the owned remote directories and referenced dependencies, and includes the existing `src/main/vite-env.d.ts` declaration; no root/shared config was edited. Whitespace validation also exited 0.
- Relay regressions run the real projector, result validator, daemon handshake/writer/channel and Worker bridge. They deliver 100 events with 10 KiB and 30 KiB text each (the original roughly 1 MiB trigger and a response near the supported 3 MiB limit), plus an exact 4 MiB Core body through both default and 32 KiB route ceilings. Tests exhaust byte/frame/shared capacity with delayed credit; cover a progress interval extending total write time beyond the stall deadline, a real stall, reset/dispose, graceful close, stream-id reuse and an independently progressing stream.
- Feishu regressions use the installed official SDK event dispatcher with synthetic events and the real mapper/event adapter/gateway. They assert `/select` and `/unsubscribe` invoke their intended Core methods without `session.send`, preserve other mentions/private commands/plain text, and retain group history redaction. Real `serverCoreHistoryEntry` multiline output reaches the reply path; plain text, `/send`, `/create` text, permission previews, invalid identifiers/control characters, byte/depth/node/cycle limits and secret redaction are covered. Bot identity lookup and startup success/failure/late-close behavior use mocked SDK network methods only.
- During development, the progress/stall regression exposed the incomplete-frame graceful-close issue described above; the final implementation resets that case. Early fixture/type errors were corrected before the final passing runs.

### Evidence and limits

- `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/remote/focused-tests.txt`: final focused output, with the repository absolute prefix removed.
- `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/remote/typecheck.txt`, `typecheck-result.json`, `tsconfig.json`: scoped compile evidence/config.
- `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/remote/changed-files.json`: exact owned file list, line counts and SHA-256 hashes at handoff.
- Fixtures use in-memory Core/stream/store boundaries and mocked SDK calls. No actual SSH/Feishu/provider calls or live credentials/databases/transcripts were used. No live listener/host or installed app was mutated, and no native binding rebuild/install was run. The existing dirty scan records and other workers' source edits were preserved.
- Real network throughput/platform behavior and live Feishu API availability were not exercised. Global typecheck, full suite, build, final archives and any separately authorized runtime restart remain lead-owned. Changed Worker/daemon and Feishu services need their next authorized restart/release to use these sources; no lifecycle action was performed.
