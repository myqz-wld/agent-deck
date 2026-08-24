---
review_id: 257
reviewed_at: 2026-08-20
baseline_commit: d3e1024374a6fecf15e597e003f2fce72550e35e
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review/changelog records, bucket moves, and indexes are mechanical evidence added after implementation."
---

# REVIEW_257_session-creation-readiness-and-stall: Audit adapter switching and create stalls

## Scope and method

This debug review traced the model projection from adapter selection through Local and Remote
creation-default requests, the shared form presentation state, Local IPC creation, Codex startup,
and skill injection. It compared every active source reference to the 150 ms constant with the
earlier readiness records and inspected the application and Codex native logs around the reported
pre-restart failure.

The repository review-expiry report was run before implementation. The review covers the complete
changed implementation and regression-test set below; unrelated expired or scope-unknown files are
not claimed.

```review-scope
src/main/codex-config/skills-installer.test.ts
src/main/codex-config/skills-installer.ts
src/main/ipc/__tests__/adapters-outgoing.test.ts
src/main/ipc/adapters.ts
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/session-dialog-actions.ts
src/renderer/components/new-session/useRemoteSessionCreation.test.tsx
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/hooks/__tests__/useDelayedAsyncFallback.test.tsx
src/renderer/hooks/__tests__/useSessionCreationOptions.test.tsx
src/renderer/hooks/useDelayedAsyncFallback.ts
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/hooks/useSessionCreationProjection.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Local dialog identity stayed constant across adapter changes, so the initial-readiness gate did not apply. Selecting Codex immediately rendered its generic fallback and later replaced it with `gpt-5.6-sol`. | Add deferred pending identity projection: retain the prior adapter's complete display for up to 150 ms, swap directly to the settled Codex result when fast, or reveal the target loading/fallback only at the boundary. |
| MEDIUM | A resolved request was remembered only by dialog scope, so every later adapter change inherited the 120 ms authoring debounce and had little chance to finish inside a 150 ms presentation grace. | Key the immediate-versus-debounced decision by scope plus adapter. Adapter changes start at once; same-adapter provider/cwd revalidation remains debounced. |
| MEDIUM | While authoritative configuration was pending, the create button remained disabled but retained its ordinary creation label. A click therefore produced no state change or log, matching the reported “no reaction” symptom. | Give the disabled state explicit `正在准备…` feedback and keep submission blocked until the target configuration is authoritative. |
| MEDIUM | Local create requests had no renderer-to-main correlation or phase marker, and Codex session setup recursively synchronized the bundled skill mirror before provider registration. A slow filesystem traversal could extend the opaque pre-registration path. | Add correlation and bounded slow-phase logging, and make per-session skill lookup a shallow read of the mirror already prepared at bootstrap/settings apply. Explicit synchronization remains the repair boundary. |

## Log evidence

- Around 20:09–20:13, the application log recorded two direct `codex-config` creation-default read
  timeouts. Codex native logs separately recorded repeated model-endpoint network failures before
  recovery around 20:13.
- The failed click produced no session-start marker, rollout, or persisted session row. This rules
  out a confirmed post-registration provider hang, but the previous build lacked a create-request
  ingress marker, so the logs cannot distinguish a disabled-button click from a pre-registration
  stall with certainty.
- The fix addresses both observable gaps: pending configuration is visible before submission, and
  accepted Local requests now have correlated ingress, two-second phase, completion, and failure
  records.

## Global 150 ms audit

- `NewSessionForm` and Local handoff retain the initial-load rule: defer incomplete content, reveal
  a complete fast result directly, and show loading only when the read crosses 150 ms.
- Local new-session and issue-resolution now use the retain-current-on-switch rule requested here.
- Remote new-session, Remote issue-resolution, and Remote handoff share the corrected adapter
  projection through `useRemoteSessionCreation`; later same-adapter refreshes still retain their
  committed presentation and use delayed progress.
- The Permissions readiness paths documented in earlier records were removed with the Permissions
  product surface. No active permission component or delayed-tab implementation remains.
- `src/main/browser-use/server.ts` and `browser-cli-broker-core.ts` each contain an unrelated 150 ms
  child-process drain/exit bound. They do not render configuration and were intentionally unchanged.

## Validation and evidence

- Regression coverage proves a fast Local Codex switch keeps the prior adapter model and then
  renders `gpt-5.6-sol` directly, while a slow switch retains the prior projection through 149 ms
  and reveals the Codex fallback/loading state at 150 ms.
- The shared deferred-identity hook and Remote creation authority have matching fast/slow timing
  coverage; stale request fencing and same-adapter revalidation coverage remain green.
- Codex skill tests prove shallow per-session lookup does not resynchronize a changed tree and an
  explicit sync still repairs it. IPC coverage proves correlation is logged but never forwarded to
  provider create options.
- `pnpm typecheck` passed architecture, Core Node, main/preload, and renderer checks.
- `pnpm test` passed 994 files and 6,241 tests; 2 files and 3 opt-in tests were skipped.
- The first final full-suite run hit one unrelated Remote directory-dialog render-timing failure;
  that file passed alone (18 tests), and the second complete run passed with the totals above.
- `pnpm build` passed main, preload, renderer, and build-info generation.
- `pnpm logger:check` passed with no direct console calls in main or renderer.
- `git diff --check` and the 500-line production-source guard passed.

## Residual risk

- The log evidence cannot retroactively identify the exact failed-click branch because the old
  installed build emitted no create ingress marker. The new correlation closes that gap for future
  reports.
- The 150 ms value is a presentation boundary, not a filesystem or network deadline. If the
  renderer event loop itself is blocked it cannot paint exactly on schedule.
- Provider network failure after a temporary session is registered remains provider-owned and may
  delay the first response; it is distinct from a silent pre-submission or pre-registration stall.
- Live installed-app acceptance is pending packaging/restart because stopping the current host app
  would terminate this development session.

## Verdict

PASS. All confirmed readiness and create-path findings in scope are fixed, with installed-app
acceptance explicitly pending restart.
