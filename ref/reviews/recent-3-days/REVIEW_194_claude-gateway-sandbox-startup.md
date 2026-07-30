---
review_id: 194
reviewed_at: 2026-07-29
baseline_commit: 375e35a384e261c9e70d9546232d5681fa4b51d1
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_194_claude-gateway-sandbox-startup: Claude Gateway sandbox startup

## Scope and method

Traced an installed-app Claude turn from the renderer through Agent Deck's SQLite event ledger and
main-process log, inspected the bundled Claude Agent SDK startup invariant, and reproduced the same
Gateway/model/authentication path with the bundled native Claude executable. Audited both the SDK
option construction and the fast-return startup-failure presentation path.

```review-scope
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/gateway-sandbox-settings.test.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query.ts
src/main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings.ts
src/main/adapters/claude-code/sdk-bridge/pending-cancellation.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Selecting a Claude Gateway while `workspace-write` or `strict` sandboxing was enabled passed both a settings file path and top-level `sandbox` to Claude Agent SDK 0.3.220. The SDK rejects that pair synchronously before spawning Claude Code, so the provider never received the prompt. | Build a private per-session settings file containing the selected profile's non-environment fields plus the requested sandbox. Move the profile `env` into this child process only, pass no top-level sandbox, and remove the derived file on startup failure, stream completion, or close. |
| HIGH | Startup cleanup set `expectedClose` before interrupting the failed query. The outer fast-return path interpreted that cleanup marker as an intentional user close and suppressed the real startup error, leaving only `finished: { ok: false }` in the activity feed. | Preserve whether close was already intentional before failure cleanup starts, and use that dedicated flag for message suppression. Real startup exceptions now emit a bounded, redacted error message while intentional close and the existing timeout message remain quiet. |

## Evidence

- Installed-app session `2c04573e-98b6-4020-9702-4f5fbc99bbb6` recorded `session-start`, user
  text `hi`, and an immediate `finished` event with `ok=false` and subtype `error`; it contained no
  assistant or error-message event.
- The main log stopped immediately after the sandbox and MCP initialization messages. No Claude
  transcript or debug file was created, placing failure before native process startup.
- Claude Agent SDK 0.3.220 explicitly throws
  `Cannot use both a settings file path and the sandbox option` during synchronous query
  construction.
- The bundled native Claude executable completed a prompt with the same DeepSeek Gateway, model,
  effort, and permission mode when invoked without the conflicting top-level sandbox. This excludes
  the selected Gateway, model, authentication, and provider inference as the cause.
- The derived-file regression verifies `0700` directory and `0600` file permissions, confirms that
  Gateway environment values are absent from the file, and proves cleanup is idempotent.
- The fast-return regression synchronously throws the SDK conflict and proves both a visible error
  message and `finished: { ok: false }` survive failure cleanup.

## Validation

- Claude adapter regression suite passed: 43 files and 309 tests.
- Full Electron-ABI suite passed: 471 files and 4,019 tests; one file and one test skipped.
- `pnpm typecheck` passed.
- `pnpm build` passed for main, preload, and renderer bundles.
- `pnpm logger:check` passed.
- All changed first-party production files remain at or below the 500-line guardrail.

## Fixes landed

- Adapted Gateway-backed sandbox sessions to the SDK's settings-file contract without mutating
  process-global environment state.
- Kept Gateway credentials in the per-child environment and out of the derived settings file and
  command line.
- Added idempotent derived-settings cleanup across startup failure, normal stream completion, and
  explicit close.
- Separated intentional-close suppression from failure-cleanup state so synchronous SDK startup
  errors remain visible.
- Added deterministic configuration, permission, cleanup, and fast-return regressions.

## Residual risk

- The currently running installed application cannot adopt main-process changes without a restart.
  A new packaged build must replace it after the active Agent Deck process exits.
- The workaround is tied to the Claude Agent SDK contract that a settings path and top-level
  sandbox are mutually exclusive. The regression protects Agent Deck if that SDK behavior changes.

## Follow-up

Package and replace the installed application after it exits, then start a fresh Claude session
with the DeepSeek Gateway and `workspace-write` sandbox and confirm the activity stream contains an
assistant response and a successful finished event.
