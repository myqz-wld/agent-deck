---
changelog_id: 589
changed_at: 2026-08-11
---

# CHANGELOG_589_codex-never-approval-default: Default Codex approvals to never

## Summary

New Codex targets now fall back to `never` approval when no explicit, resolved, or persisted
same-adapter value exists. Sandbox defaults and last-used selection memory remain unchanged.

## Changes

- Use `never` as the final Codex approval fallback for new-session defaults, the CLI, non-UI
  adapter callers, MCP spawns, cross-adapter handoffs, and missing Local or Remote runtime values.
- Preserve explicit `untrusted`, `on-request`, and `never` values, native Codex configuration when
  resolved by the new-session default service, same-adapter inheritance, and same-process
  last-used UI selections.
- Keep the configured Codex sandbox default independent from approval policy; this change does not
  widen filesystem, network, or additional-directory access.
- Align injected Codex instructions, bundled reviewer guidance, MCP tool/schema descriptions,
  project documentation, and code-level runtime contracts with the new fallback.
- Add regression coverage for CLI, default resolution, IPC, MCP spawn, handoff, Local controls,
  Remote controls, and the renderer's failure-safe initialization path.

## Validation

- The focused regression matrix passed: 11 test files and 192 tests covering CLI, default
  resolution, teammate spawning, MCP tools, IPC, handoff, bundled reviewer configuration, Local
  and Remote controls, and renderer initialization.
- `pnpm build` passed, including main, preload, and renderer bundles.
- `pnpm typecheck` passed both architecture boundary checks and the Node TypeScript stage. The Web
  TypeScript stage remains blocked by concurrent, unrelated Remote handoff work whose tests and
  component props are temporarily out of sync.
- The full test run passed 5,753 tests and failed four tests owned by that concurrent Remote,
  protocol, and attachment-steering work. A follow-up rerun confirmed one timing-sensitive Remote
  issue test now passes; the remaining three stale expectations are outside this change's scope.
- `git diff --check`, prompt-asset inventory/backup hash verification, and the repository's
  500-line production-file limit checks passed for this change.

## Do Not Split Protection

The change updates one shared fallback contract across existing ownership boundaries. It adds no
new production module and does not move approval, sandbox, inheritance, or memory ownership.

## Compatibility and recovery

Existing sessions retain their persisted approval policy. Callers can still choose `on-request`
or `untrusted`, and a configured or same-adapter inherited value still wins. With
`workspace-write + never`, an operation outside the sandbox fails directly instead of opening an
approval request; users who want escalation prompts can explicitly select `on-request`.

This record supersedes only the approval fallback restored by
`CHANGELOG_410_codex-live-approval-review-runtime.md`; its live selector, approval bridge, and
reviewer no-hidden-elevation boundaries remain in force.
