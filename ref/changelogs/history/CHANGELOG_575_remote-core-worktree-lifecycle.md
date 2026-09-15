---
changelog_id: 575
changed_at: 2026-08-07
---

# Remote Core Worktree Lifecycle

## Summary

Restore `enter_worktree` and `exit_worktree` for Remote provider sessions through the same durable
automatic cwd-transition state machine used by Local, while keeping every public path inside the
authoritative Workspace.

## Changes

- Added Core-owned MCP worktree tools, invocation correlation, provider-event fencing, buffered
  ingress replay, transition recovery, and clean shutdown. Claude, Codex, and Grok provider hosts
  now feed their real tool/turn events and message ingress through this lifecycle.
- Reused the durable transition and input repositories without importing Electron registries. The
  Core composition owns its adapter registry, session cwd persistence, status publication, cleanup
  reference graph, and startup recovery ordering.
- Worktree creation accepts only Workspace-relative paths, validates the Git common directory and
  detached commit inside Workspace, rejects Worker-private roots and symlinked parents, and never
  returns an absolute host path.
- Exit verifies the exact lease, durable HEAD reference, dirty state, live/persisted session
  references, and concurrent leases before removal. `discardChanges=true` remains an explicit
  user-authorized destructive exception and cannot discard an unreferenced commit.

## Validation

- A real temporary Git repository passed enter, automatic provider interruption, cwd switch,
  buffered message replay, exit, original-cwd restoration, and safe worktree removal.
- Focused canonical Electron validation passed 4 files / 14 tests. `pnpm typecheck`, architecture
  boundaries, and 121 executable Core candidates passed.

## Evidence Limits

- This is deterministic Git/provider-adapter evidence on macOS, not target Linux filesystem or
  package acceptance. Browser, presentation/handoff MCP, hooks, and private Grok authentication
  remain active Task 4 work.
- No shared Electron, SSH, Relay, Worker, or VLESS process was restarted, stopped, or killed.
