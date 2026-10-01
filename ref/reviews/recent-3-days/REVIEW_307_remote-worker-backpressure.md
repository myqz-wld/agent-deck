---
review_id: 307
reviewed_at: 2026-09-30
baseline_commit: 8a9e93a0baf02d89c085f8e9511f3de577dbae58
expired: false
---

# Remote Worker backpressure and independent owner work

## Scope and method

Local source review, read-only production reproduction, real pipe and SQLite regressions.
No additional agents or independent review claim. Review expiry was checked; unrelated legacy
coverage is outside this bounded review.

```review-scope
src/hosts/local-worker/openssh-connector.test.ts
src/hosts/local-worker/openssh-connector.ts
src/hosts/local-worker/openssh-frame-writer.test.ts
src/hosts/local-worker/openssh-frame-writer.ts
src/hosts/server-core/creation-guard-sessions.ts
src/hosts/server-core/feishu-work-management.fixture.ts
src/hosts/server-core/feishu-work-management.test.ts
src/hosts/server-core/feishu-work-management.ts
src/hosts/server-core/feishu-work-origins.test.ts
src/hosts/server-core/mcp-session-spawn.test-fixtures.ts
src/hosts/server-core/mcp-session-spawn.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-metadata-store.ts
src/main/store/session-repo/__tests__/independent-work.test.ts
src/main/store/session-repo/independent-work.ts
src/main/store/session-repo/index.ts
```

## Findings and repairs

HIGH: Switching to Remote or opening a detail could immediately retire the shared Worker SSH
attachment. Serial reads and a complete registry/long-poll probe passed. Three concurrent reads
returning approximately 42 KB each reproduced the failure: the first reply arrived and subsequent
reads failed with connection_failed. The Relay container stayed healthy without restarting.
The Worker connector treated Node write(false) as fatal on the next frame, although the previous
frame had been accepted and only subsequent writes needed to wait for drain.

The connector now uses a bounded FIFO writer. Pending byte/frame accounting includes accepted but
incomplete writes. Drain resumes delivery in order; errors, a stalled-progress deadline and owned
child retirement close the queue. Default bounds are 8 MiB/1,024 frames and 15 seconds without
progress. Negotiated frame limits, credential scope and process identity fences are unchanged.

MEDIUM: Natural owner work reused the assistant's spawn edge and appeared as an agent child.
Registration still proves the created target before synchronously promoting it to a root, ahead
of provider output and Feishu routing. The admission reservation remains held until committed
creation provenance is available. Shared limits count genuine children and live independent work.
Canonical identity checks, rollback, native controls and newer manual names/selections remain.

Committed feishu.work.create results now retain creator provenance beyond ordinary mutation
expiry. Startup repair acts only on a retained successful creation whose current parent matches
that creator. Its genuine delegated descendants keep their edges and receive consistent depths
inside one SQLite transaction. Unrelated children are untouched; repeated repair is a no-op.
Provenance pagination releases SQLite statements before change publication. No schema migration,
protocol change, prompt edit or model/policy update is required.

## Validation

- The corrected initial-write regression fails against old source. Real low-watermark pipe
  coverage delivers three concurrent 42 KB replies with byte/ordering checks and no retirement.
- Targeted transport suite: 54 passing tests. New cases also cover byte/frame bounds, delayed
  callbacks, failure and progress timeout. SQLite tests cover targeted promotion, descendant
  rebasing, wrong-parent rejection, inconsistent cycles, durable origin retention and pagination.
- Before integration, 6,908 tests passed with three existing skips. After preserving main's
  independently completed Gateway recovery, the merged suite passes 6,913 tests with six skips
  (three original and three opt-in native Gateway cases); 1,119 files pass. An initial
  run used umask 077 and failed unrelated fixtures that require explicit public artifact modes;
  the complete rerun under the normal umask passed without product/test relaxations.
- Typecheck/architecture, application build, headless build/check and deployment checks pass.
  The existing native Feishu archives were checksum-verified and their embedded JavaScript is
  byte-identical to the current headless output. No Server/Feishu upgrade is needed.
- All touched source/test files remain below 500 lines. README and prompt assets are unchanged.

## Residual risk and activation

This record covers source validation. Installed Desktop/Worker activation and the owner's Remote
page check are pending. Existing origin records already pruned by an older release cannot be
inferred from arbitrary parent links; such links are deliberately preserved. Retained provenance
uses one existing creation result per work session and does not store new message bodies.
The earlier warm-channel stall remains unproven and is not retroactively attributed to this bug.
