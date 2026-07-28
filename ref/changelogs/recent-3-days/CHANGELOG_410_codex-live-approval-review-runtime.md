---
changelog_id: 410
changed_at: 2026-07-28
---

# CHANGELOG_410_codex-live-approval-review-runtime: Restore interactive Codex defaults

## Summary

Codex targets now default to `approvalPolicy: on-request` when neither an explicit value nor a
persisted same-adapter value applies. Active Codex session pages expose the same
strict-to-permissive approval selector used at creation, and changes apply to the next turn without
interrupting the current response.

Simple/deep review no longer receives runtime access from a `reviewer-*` name. Review skills omit
permission, approval, and sandbox overrides unless the user explicitly requested exact values, so
same-adapter workers inherit the lead and cross-adapter workers use target defaults. Reviewer
prompts allow isolated spike validation while keeping reviewed source and Git state unchanged.

## Changes

### Codex approval behavior

- Restore `on-request` in adapter, renderer, config-resolution, spawn, and hand-off fallback paths.
- Add public Codex-only `approvalPolicy` fields to `spawn_session` and `hand_off_session`, ordered
  as `untrusted`, `on-request`, then `never`.
- Preserve precedence as explicit value, persisted same-adapter value, then the Codex
  `on-request` target default; never copy runtime access across adapters.
- Add a live session-page approval selector. The main process persists the choice, emits the
  updated session record, and patches app-server thread options for subsequent `turn/start`
  requests. A failure rolls both database and in-memory projections back.
- Keep an active turn and its queued messages intact while changing the next-turn policy.

### Review runtime ownership

- Remove options-builder branches that inferred Codex approval, network, and additional-directory
  access from `reviewer-claude`, `reviewer-codex`, or `reviewer-grok`.
- Make omission explicit in all simple/deep review counterparts: same-adapter inheritance,
  cross-adapter target defaults, and user-explicit overrides only.
- Permit focused tests, builds, package validation scripts, and isolated spikes. Review workers may
  create disposable fixtures and generated output below their reviewer-specific
  `/tmp/agent-deck-review/...` directory, but do not edit scoped source, the Git index, commits, or
  user changes.
- Align Claude, Codex, and Grok reviewer assets with the same prompt-owned boundary.

### `.git` permission diagnosis

Codex `workspace-write` intentionally keeps repository metadata such as `.git/index` read-only.
The observed `.git/index.lock: Operation not permitted` was therefore an expected sandbox boundary,
not a broken repository mount. The regression was the `never` approval default: it made a Git write
fail immediately instead of surfacing an escalation request. Restoring `on-request` preserves the
`.git` protection while allowing the user to approve staging or committing when needed.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed: 402 test files and 3,379 tests passed; one opt-in live smoke file/test was
  skipped.
- `pnpm build` passed.
- `pnpm logger:check` passed with no `console.X` residue.
- Focused adapter, app-server, IPC, MCP, hand-off, prompt-resource, and renderer suites also passed
  with 166 tests during iteration.
- The three simple-review assets and three deep-review assets are byte-identical within each pair.
- `git diff --check` passed.

## Do Not Split Protection

All changed production TypeScript and TSX files remain at or below 500 lines.

## Notes

- This changelog supersedes CHANGELOG 409's Codex `never` target-default and reviewer-runtime
  sections. Historical sessions keep their persisted selection and can change it from the session
  page.
- Pre-edit prompt assets can be restored from
  `.prompt-asset-improver/local/backups/20260728T072050Z/`.
