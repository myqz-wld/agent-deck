---
changelog_id: 594
changed_at: 2026-08-12
---

# CHANGELOG_594_initial-readiness-and-permission-preload: Delay fast async fallbacks until needed

## Summary

New-session forms and Local/Remote permission details now share a 150 ms initial-read grace. Fast
reads settle behind the current or hidden view and reveal the final data directly; reads that exceed
the grace period switch to an explicit loading state. This removes momentary model and
permission-page jumps without moving filesystem work onto Electron's blocking main-process path.

## Changes

### New-session readiness

- Keep the incomplete new-session form out of view for the first 150 ms while the adapter inventory
  and initial defaults request settle. Reveal the final form directly when they finish within that
  grace, or an explicit loading shell when they take longer. Once ready, later directory, provider,
  or adapter changes retain the existing interactive refresh behavior.
- Start the first defaults request immediately; retain the 120 ms debounce only for subsequent
  authoring changes.
- Apply the same initial-readiness contract to Local and Remote creation and to both issue-resolution
  creation dialogs.
- Remove the duplicate Local working-directory help below the input. The placeholder
  `留空则使用主目录（~）` remains the single explanation.

### Permission detail readiness

- Start the bounded Local permission-settings scan when Session Detail mounts instead of waiting
  for the Permissions tab to mount.
- If Local Permissions is selected before that first scan settles, keep the current detail page
  visible for up to 150 ms. Switch directly to the final result when it settles within the grace,
  or to the existing scanning state when it takes longer. A later user-selected tab cancels that
  pending switch.
- Keep Remote permission details lazy because their data comes from Remote Core rather than a fast
  local file read, while applying the same post-click grace before showing its loading page.

### Local configuration reads

- Read Codex `config.toml` once for the permission projection, cap the snapshot at 256 KiB, and
  derive the displayed top-level model from the same snapshot. This replaces the previous
  unbounded raw read plus a second synchronous model read.
- Preserve asynchronous local filesystem access throughout the application and centralize the
  renderer-side fast-read grace. The audit found that those paths protect the Electron main loop,
  process potentially large files or directory trees, enforce descriptor/identity checks, or
  already belong to asynchronous deployment/runtime lifecycles. Changing them wholesale to
  synchronous reads would add blocking, while renderer IPC would remain asynchronous and still
  need an explicit presentation boundary.

## Validation

- Focused new-session and Local/Remote permission grace coverage passed 4 files / 27 tests.
- `pnpm typecheck` passed the architecture boundaries and both Node and Web TypeScript checks.
- The complete `pnpm test` suite passed 944 files and 6,052 tests; 2 files / 3 conditional tests
  were skipped.
- `pnpm build` and `git diff --check` passed.

## Do Not Split Protection

No exception is required. Every changed production source file remains below 500 lines; the
largest touched production file is `SessionDetail/index.tsx` at 354 lines.

## Notes

- Main-process permission/config code changed, so a development runtime must be restarted before
  the new scanner behavior is active. No persistence schema, preload contract, or IPC channel
  changed.
- The complete asynchronous-read assessment and retained-rationale inventory are recorded in
  `REVIEW_235_async-local-file-read-audit.md`.
