---
review_id: 261
reviewed_at: 2026-08-23
baseline_commit: eeb1ab6d67ef40645d367ecc3d3b3d8190c2758c
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review/changelog records, bucket moves, and indexes are mechanical evidence added after implementation."
---

# REVIEW_261_session-config-read-latency: Diagnose adapter-default read timeouts

## Scope and method

This debug/performance review traced a Local new-session adapter switch from the renderer's 150 ms
presentation boundary through IPC, provider-specific default resolution, bounded config reads, and
the installed Electron runtime. It compared production warnings with file metadata, standalone
Node reads, a fresh Electron application-context probe, the running main process, and the exact
replacement algorithm.

The repository review-expiry report was run before implementation. This review covers the complete
changed implementation and regression set below; it does not claim unrelated expired or
scope-unknown files.

```review-scope
src/main/adapters/__tests__/session-creation-config-reader.test.ts
src/main/adapters/__tests__/session-creation-defaults-host.test.ts
src/main/adapters/session-creation-config-reader.ts
src/main/adapters/session-creation-defaults-core.ts
src/main/adapters/session-creation-defaults.ts
src/main/ipc/__tests__/adapters-outgoing.test.ts
src/main/ipc/adapters-session-creation-defaults.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | The running installed app repeatedly classified Claude, Codex, and Grok host config reads as 250 ms timeouts, forcing adapter switches past the 150 ms visual grace. The files were only 830 B to 53,764 B and completed in 0.16-9.48 ms in standalone Node and fresh Electron probes. | Replace the generic `ReadStream` path with one `original-fs` host descriptor and a fixed `maxBytes + 1` read loop. Preserve asynchronous main-process behavior, strict memory/parse bounds, timeout settlement, and eventual descriptor cleanup. |
| MEDIUM | Existing diagnostics emitted only source plus `timeout`, so they could not distinguish Electron wrapper selection, open queueing, read latency, close latency, or aggregate IPC delay. | Add path-free backend/stage/duration/byte evidence to read failures, slow-success evidence above 150 ms, and adapter-level IPC duration above 150 ms. |
| LOW | The bounded reader's tests exercised only injected readers, leaving the production filesystem path and exact oversize boundary unproved. | Add real temporary-file coverage for a successful read and a read stopped at exactly `maxBytes + 1`; run the same focused tests under Electron and plain Node. |

## Evidence

- The active config files were regular mode-0600 files sized 8,875 B (Claude), 53,764 B (Codex),
  and 830 B (Grok).
- The prior stream algorithm completed those files in 0.16-2.59 ms in Node and 0.26-9.48 ms in a
  fresh Electron 33 application context. There was no sandbox denial, file-descriptor exhaustion,
  abnormal thread count, or >=500 ms main-event-loop warning.
- The installed runtime nevertheless emitted repeated `claude-settings`, `codex-config`, and
  `grok-config` timeout fallbacks. Multiple independent Claude paths timing out together points to
  the running process's shared stream/scheduling path rather than file size or disk throughput.
- The replacement production algorithm completed the same files through Electron `original-fs`
  in 2.73 ms, 0.24 ms, and 0.11 ms respectively.

## Validation

- Focused Electron suite: 6 files / 40 tests passed.
- Plain-Node fallback suite: 2 files / 21 tests passed.
- `pnpm typecheck` passed architecture, Core Node, and TypeScript checks.
- `pnpm build` passed main, preload, renderer, and build-info generation; the built main bundle
  contains the `electron-original-fs` backend and both slow-path diagnostics.
- `pnpm logger:check` passed.
- First complete `pnpm test`: 999 files passed, 2 failed, and 2 skipped; 6,263 tests passed, 2
  failed, and 3 skipped. The unrelated Remote Issues timing failure passed immediately alone.
- Complete suite with only the deterministic pre-existing Browser README assertion excluded: 1,000
  files passed and 2 skipped; 6,261 tests passed and 3 skipped. Remote Issues also passed here.
- `git diff --check` and the production 500-line guard passed.

## Residual risk

- Live installed-app timing cannot be accepted until the main process is rebuilt and restarted.
  The new diagnostics will identify `opening`, `reading`, `closing`, or aggregate resolution if a
  post-restart request still crosses 150 ms.
- Descriptor `read()` cannot cancel an already-running OS request. The outward response still
  settles at 250 ms, and late work observes the abort and closes its descriptor when the operation
  returns, matching the prior bounded-response contract without unbounded memory use.
- `src/main/codex-config/__tests__/bundled-browser-skill.test.ts` deterministically expects Browser
  wording removed by the current baseline's streamlined README. It is unrelated to this scope and
  remains the only deterministic full-suite failure.

## Verdict

PASS with live acceptance pending restart. The confirmed stream-path latency hotspot is removed,
the security bounds remain intact, and any remaining >150 ms delay is now attributable by stage.
