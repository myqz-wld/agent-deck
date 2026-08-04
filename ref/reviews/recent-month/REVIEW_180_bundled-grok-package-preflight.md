---
review_id: 180
reviewed_at: 2026-07-27
baseline_commit: bf7f7f6c85af6b42e94d88b31f878617db0766de
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_180_bundled-grok-package-preflight: Bundled Grok package completeness

## Scope and method

Traced the Settings authentication-probe failure from the renderer IPC response through the Grok
binary resolver, compared the installed application bundle with a clean current package, and
reproduced package resolution under Electron-as-Node from each `app.asar`.

```review-scope
README.md
package.json
scripts/verify-bundled-grok.mjs
src/main/adapters/grok-build/__tests__/packaging-preflight.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The installed application was built after `@xai-official/grok` entered `package.json`, but its stale `node_modules` omitted both the meta package and `@xai-official/grok-darwin-arm64`. electron-builder did not reject the unresolved production dependency and produced a working application whose bundled Grok adapter always failed before ACP initialization. | Added a packaging preflight that resolves the meta and current-platform packages, requires matching versions, and verifies a non-empty native or Brotli payload. Every installer script now runs it before compilation and electron-builder. |

## Evidence and validation

- The installed build at commit `181a79564a1e` fails Electron `require.resolve` for both
  `@xai-official/grok/package.json` and
  `@xai-official/grok-darwin-arm64/package.json`.
- `pnpm verify:bundled-runtimes` resolves
  `@xai-official/grok-darwin-arm64@0.2.112` on Darwin ARM64.
- Regression coverage builds isolated package fixtures and proves both the valid compressed-payload
  path and the missing-dependency fail-fast path.
- `pnpm typecheck` passed.
- The full `pnpm test` suite passed 378 files and 3,168 tests; one file and one credentialed smoke
  test remained skipped.
- `pnpm dist` passed after the new preflight and produced the DMG plus its block map.
- The packaged Electron runtime resolves both Grok package manifests from `app.asar`, while the
  35 MB platform payload is present in `app.asar.unpacked`.
- Executing the packaged trampoline with an isolated `GROK_HOME` materialized and ran
  `grok 0.2.112 (9bbd559437aa)`.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.

## Fixes landed

- Added a deterministic, package-manager-layout-aware Grok packaging preflight.
- Reject missing platform packages, mismatched versions, empty packages, and absent native
  payloads with an actionable `pnpm install` error.
- Wired all installer targets through the preflight and documented the standalone verification
  command.
- Added focused success and missing-dependency regression tests.

## Residual risk and boundaries

- The preflight verifies the host platform selected by the packaging process. Cross-compiling an
  installer for another operating system still requires installing that target's optional package
  and should be performed on the target platform.
- The already running installed application cannot gain missing `app.asar` entries in place. It
  must be replaced with the validated rebuilt bundle after its active sessions are stopped.
- The preflight prevents stale dependency trees from producing another invalid installer, but it
  does not perform network installation automatically.

## Follow-ups

Replace the stale installed bundle with the rebuilt application after the current Agent Deck
process exits, then repeat the no-prompt ACP authentication probe.
