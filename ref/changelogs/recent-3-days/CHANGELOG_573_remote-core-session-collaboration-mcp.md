---
changelog_id: 573
changed_at: 2026-08-07
---

# Remote Core Session Collaboration MCP

## Summary

Run session discovery, activity lookup, cross-session messaging, and shutdown through the same
private Core-owned Agent Deck MCP channel used by Remote provider sessions.

## Changes

- Expanded the Core MCP host from task/issue tools to `list_sessions`, `get_session`,
  `list_session_events`, `send_message`, and `shutdown_session`, preserving the Local tool names and
  result conventions without importing Electron services into the headless bundle.
- Added source/spawn/team/handoff visibility rules, Workspace-relative cwd projection, private and
  outside-Workspace path redaction, and bounded event payload projection.
- Added a durable message dispatcher over the existing SQLite message state machine. Delivery is
  rate- and batch-bounded, team/reply scope is rechecked at delivery time, ambiguous startup state
  is terminalized at most once, and provider injection uses the normal adapter message path.
- Made repository diagnostics Core-safe and fixed lazy message/team repositories so a restarted
  Core binds the current SQLite connection instead of retaining a previously closed database.

## Validation

- Real repository and fake-adapter collaboration tests cover related/default visibility, explicit
  spawn recovery, Workspace projection, event redaction, teamless/team messaging, reply fencing,
  and unrelated shutdown while self-shutdown remains denied.
- Core lifecycle, broker/server, message/team repository, and runtime-composition suites passed;
  `pnpm typecheck` passed both architecture gates and both TypeScript projects.

## Evidence Limits

- This closes the five session collaboration tools. Remote `spawn_session`, `hand_off_session`,
  presentation, and worktree tools remain active Task 4 work.
- No shared process was stopped or restarted, and no real Linux/Full/provider acceptance is claimed.
