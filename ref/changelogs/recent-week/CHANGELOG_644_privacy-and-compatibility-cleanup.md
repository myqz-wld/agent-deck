---
changelog_id: 644
changed_at: 2026-09-16
---

# Remove identifying paths and retired compatibility

## Changes

- Replace the recorded production address with a documentation-range IP and replace personal
  directory examples with neutral workspace fixtures. Replace machine temporary paths in the
  archived reviewer record with a portable temporary-directory reference.
- Exclude `build/**/*.log` from Electron application packaging. The ignored local installation log
  was also sanitized; the Git ignore rule alone did not prevent packaging that file.
- Remove the Browser engine's retired `BrowserWindowTabSurface`, `createWindow` injection, optional
  `EngineTab.window`, and unused window-construction options. Production and tests now use the
  current `EngineTabSurface` contract, while production continues using `WebContentsView`.
- Remove the obsolete string-form Codex JSON-RPC error alternative. The installed Codex 0.154.0
  schema specifies an error object. Malformed string payloads produce the generic failure message.

## Validation

- `pnpm typecheck` passed both architecture checks and TypeScript configurations.
- Targeted Browser and path-fixture tests: 24 files, 248 tests passed.
- `pnpm test`: 1,027 files and 6,364 tests passed; 2 files and 3 opt-in tests skipped.
- `pnpm build` and reproducible `pnpm build:linux-headless` passed.
- The real Electron-builder file matcher rejects root/nested build logs and retains runtime assets.
- `git diff --check` passed. No application instance or installed bundle was replaced.

## History cleanup

The user also authorized historical path/IP removal. A private external bundle and complete Git
directory backup preserve recovery data and the existing stash. All 1,400 commits were preserved, 1,387 IDs changed, the stash survived, and origin/main was
updated with an exact lease. The current code tree was identical across rewriting. Verification is
recorded in `REVIEW_274_privacy-and-compatibility-cleanup.md` and the archived final plan.

## Related record

- `ref/reviews/recent-3-days/REVIEW_274_privacy-and-compatibility-cleanup.md`
