---
review_id: 203
reviewed_at: 2026-07-31
baseline_commit: b268d7b3336a7eaf827efda83a7356988d44da2d
expired: false
---

# REVIEW_203_hook-config-and-development-navigation-safety: Hook ownership and renderer reload safety

## Scope and method

Reviewed every path that creates, recognizes, updates, removes, or reports Agent Deck hooks for
Claude Code, Codex CLI, and Grok Build. Traced the reported renderer crash from
`window.api.onSessionUpserted` through Electron preload loading, Vite full reloads, the main-window
navigation policy, and `shell.openExternal`.

```review-scope
package.json
pnpm-lock.yaml
src/main/hook-server/curl-command.ts
src/main/hook-server/curl-command.test.ts
src/main/hook-server/hook-config-file.ts
src/main/hook-server/hook-config-file.test.ts
src/main/hook-server/hook-relay-config.ts
src/main/hook-server/hook-relay-config.test.ts
src/main/adapters/types/adapter-context.ts
src/main/index/bootstrap-infra.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/hook-installer.ts
src/main/adapters/claude-code/__tests__/hook-contract.test.ts
src/main/adapters/claude-code/__tests__/post-compact-hook.test.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/hook-installer.ts
src/main/adapters/codex-cli/__tests__/hook-installer.test.ts
src/main/adapters/grok-build/index.ts
src/main/adapters/grok-build/hook-installer.ts
src/main/adapters/grok-build/__tests__/hook-installer.test.ts
src/main/window/navigation-policy.ts
src/main/window/__tests__/navigation-policy.test.ts
src/renderer/main.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Generated hook commands embedded the hook-server bearer token directly in Claude, Codex, and Grok user/project configuration. Project files may intentionally be group/world readable, and copied diagnostics could disclose the token. | Commands now reference adapter/event-specific curl configs under the Electron `userData/hook-relay` directory. The directory is forced to `0700`, relay files to `0600`, and hook JSON contains no bearer token. |
| HIGH | Ownership used an Agent Deck comment substring, so an unrelated user hook containing the same text could be removed during install or uninstall. | Current ownership requires the exact adapter/event v2 command. An explicit one-time migration recognized only `curl` commands with the exact loopback event route and an exact terminal historical tag. After migration and verification, the runtime legacy recognizer was removed; historical-looking commands are now preserved as user-owned. |
| HIGH | Installers rewrote whole JSON documents and some paths coerced malformed hook shapes. Concurrent writers, symlinks, crashes, or malformed structures could overwrite user configuration or silently discard hooks. | A shared JSONC AST writer now validates shapes before mutation, serializes writers with an advisory lock, rejects symlink mutation, preserves existing modes/comments/unrelated fields, writes an exclusive temporary file with file and directory fsync, performs a compare-and-swap check, and atomically renames. Malformed shapes fail closed with byte-for-byte preservation. |
| MEDIUM | The navigation policy treated Vite same-origin full reloads as external HTTP navigation. Each source change opened `http://localhost:5173/` in a normal browser, where Electron preload is absent, producing the reported `onSessionUpserted` crash. | Same-origin HTTP(S) reloads remain in the existing Electron renderer. Same-origin new windows are still denied, cross-origin links still open externally, and renderer bootstrap shows a controlled preload-unavailable screen instead of mounting `App` without `window.api`. |

## Fixes landed

- Added adapter/event-specific private relay configs with strict token, route, port, path, and
  permission validation.
- Added event-specific v2 ownership tags and used exact historical ownership recognition only for
  the explicit one-time user-config migration.
- Added one shared hook-config transaction path for all three adapters.
- Preserved user hooks, top-level fields, JSONC comments, indentation, line endings, and existing
  file modes.
- Defaulted new user configs to `0600` and project configs to `0644`.
- Migrated the current user's Claude, Codex, and Grok hook configurations to v2, then removed the
  runtime legacy recognizer. Verification found 16 Claude, 11 Codex, and 14 Grok v2 commands, with
  zero legacy tags and zero embedded bearer tokens.
- Added fail-closed malformed JSON/shape, symlink, competing-write, no-op, permissions,
  idempotency, exact-v2 ownership, and historical tag-collision coverage.
- Allowed Vite same-origin reloads without weakening cross-origin navigation blocking.
- Added a renderer startup gate for pages that do not have the Electron preload bridge.

## Validation and evidence

- `pnpm typecheck` passed.
- Focused post-migration hook suite: 7 files and 31 tests passed.
- `pnpm test` passed: 480 files and 3,930 tests passed; one file and one test were
  intentionally skipped.
- `bash scripts/file-level-review-expiry.sh` completed before this review.
- `git diff --check` passed.
- Process inspection confirmed the existing Electron, renderer, and Vite PIDs remained alive
  throughout implementation and validation. They were terminated only afterward, following a
  separate explicit user request.

## Residual risk

- The explicit migration covered the current user's provider-level files. Historical hooks in
  project-local or other uninspected scopes are no longer recognized or removed by the runtime;
  they remain user-owned and may run alongside v2 hooks until the user removes them manually.
- Relay files are intentionally retained after uninstall because user and project scopes can share
  the same adapter/event relay. They remain under the app-owned `0700` directory with `0600` mode.
- The previous development main process had the old navigation handler in memory and was stopped
  only after explicit user authorization. The fix takes effect on the next normal development
  launch; this work does not automatically restart it.
