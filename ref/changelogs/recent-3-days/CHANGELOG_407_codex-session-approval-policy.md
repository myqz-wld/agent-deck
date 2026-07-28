---
changelog_id: 407
changed_at: 2026-07-27
---

# CHANGELOG_407_codex-session-approval-policy: Choose approvals when creating Codex sessions

## Summary

Human-created Codex sessions can now select one thread-wide approval policy at creation time.
Both the standard new-session dialog and Issue “resolve in new session” dialog offer native
`untrusted`, `on-request`, and `never` values. The initial value reflects effective Codex
configuration and falls back to `on-request` when no valid configured value is available.

Approval policy remains separate from sandbox access. The UI makes clear that `never` suppresses
interactive approval prompts without widening filesystem or network permissions; an operation
that still requires approval may fail directly.

## Changes

### Creation UI

- Add a shared Codex approval-policy picker to both human new-session entry points.
- Remember the most recent Codex selection across those dialogs during the current app run while
  keeping adapter defaults isolated.
- Resolve and display the concrete effective Codex policy instead of an ambiguous follow-default
  option.
- Render policy before the Codex sandbox selector and expose explicit accessible labels.

### IPC and lifecycle

- Validate `approvalPolicy` against `untrusted | on-request | never` at the IPC trust boundary.
- Reject the field for Claude Code and Grok Build instead of silently discarding it.
- Apply the selected concrete value to the Codex create options after the public MCP-oriented
  builder, so `spawn_session` and `hand_off_session` schemas remain unchanged.
- Reuse the existing Codex bridge persistence and recovery path for explicit session overrides.

### Documentation and tests

- Document Codex session approvals and their separation from sandbox access in the README.
- Cover both renderer entry points, last-selection memory, invalid/foreign IPC input, explicit
  passthrough, effective-config resolution, and Issue resolution creation.

## Validation

- `pnpm typecheck` passed.
- Focused approval-policy and concrete-default regression tests passed.
- Full `pnpm test` passed 401 files and 3,367 tests; one opt-in credentialed smoke test remained
  skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- An isolated local renderer preview showed the resolved initial policy, explanatory copy, all
  three options,
  and a successful switch to “从不询问”.

## Do Not Split Protection

All changed and new production TypeScript files remain at or below 500 lines. The largest is
`NewSessionDialog.tsx` at 438 lines.

## Notes

- The existing read-only permissions page already reports an explicit session override and needs
  no behavior change.
- This delivery intentionally does not add per-MCP server/tool approval controls or widen the
  agent-facing session orchestration contract.
