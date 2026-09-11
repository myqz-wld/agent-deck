---
review_id: 224
reviewed_at: 2026-08-10
baseline_commit: c07d1fe5c9a464f6093dae516b9361c7c65de673
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, review, changelog, and bucket-index maintenance are mechanical records."
---

# REVIEW_224_macos-worker-clean-exit-recovery: Always-on Worker clean-exit recovery

## Scope and method

The stopped macOS Relay Worker was traced through its installed LaunchAgent state, process exit
status, generated plist, local application replacement process matching, and terminal-only Worker
lifecycle. Neither the simple-review nor deep-review skill was invoked.

Review scope:

- `src/hosts/local-worker/terminal-service.ts`
- `src/hosts/local-worker/terminal-service.test.ts`

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The local installer process pattern also matches the packaged Worker Node. Worker handles that termination cleanly, but the macOS LaunchAgent used `KeepAlive.SuccessfulExit=false`, so launchd left the always-on Worker stopped after exit 0. | Generate an unconditional `KeepAlive=true` LaunchAgent. Explicit `stop` and `remove` still unload it through `launchctl bootout`, so intentional lifecycle control remains authoritative. |

No confirmed source finding remains open.

## Validation and evidence

- Live Worker verification reported stopped; `launchctl print` showed the exact loaded job not
  running after one run with exit code 0, and no Worker process remained.
- The installed plist contained `KeepAlive.SuccessfulExit=false`; the application installer kill
  pattern is a prefix of the packaged `Agent Deck Worker Node` executable path.
- `pnpm exec vitest run src/hosts/local-worker/terminal-service.test.ts` passed 3 tests.
- `pnpm typecheck` passed, including architecture-boundary checks.
- `pnpm check:deployment` passed.
- `pnpm test -- --reporter=dot` passed 862 test files and 5,632 tests, with 2 files and 3 tests
  skipped.
- `git diff --check` passed.

## Fixes landed

- Changed the macOS Worker LaunchAgent to remain alive after clean unexpected exits.
- Strengthened regression coverage to require unconditional keepalive and reject the old
  `SuccessfulExit` condition.

## Residual risk

- Existing installed LaunchAgent definitions retain their prior policy until an updated signed
  application is installed and a Worker start rewrites them. The terminal deployment workflow must
  restore the current Worker before live acceptance.
- This change does not alter Linux systemd policy; the observed failure path is specific to macOS
  application-bundle replacement.

## Follow-ups

None.

## Final verdict

PASS for source validation. Live Worker restoration and verification remain deployment gates.
