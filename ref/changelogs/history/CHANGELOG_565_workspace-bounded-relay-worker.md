---
changelog_id: 565
changed_at: 2026-08-06
---

# Workspace-Bounded Relay Worker

## Summary

Add a terminal-managed Local Worker with purpose-locked Relay credentials and one authoritative
Workspace shared by Desktop and Feishu client surfaces.

## Changes

- Split the version-2 connection bundle into exact Client and Worker purposes. Relay issues the
  single active Worker identity separately from independently revocable Client identities, and
  neither role can be selected or upgraded through a wire payload.
- Added terminal-only `agent-deck-worker configure/start/status/stop/remove` lifecycle management
  for macOS and Linux. Worker credentials, workspace paths, topology, and instance identity never
  cross the Electron preload or renderer boundary.
- Added the shared Workspace Sandbox contract, canonical root identity checks, Linux bubblewrap
  launch policy, macOS bookmark/signed-runtime packaging, private provider-home projection, and
  provider child-policy intersection.
- Allowed the remote create flow to select the Workspace root or an existing normalized nested
  directory without exposing an absolute path. Core re-resolves each directory and rejects
  traversal, absolute paths, symlink escapes, and unavailable replacements.
- Bound Desktop SSH and Feishu session-console clients to the same Core-owned Workspace authority.
  Feishu directory lists contain only relative public references, and group chats do not expose
  directory suggestions.
- Added process-owned Codex permission profiles and Claude managed sandbox settings so a provider
  selection can narrow Workspace access but cannot turn `off` or `danger-full-access` into host or
  Worker-private filesystem access. Grok remains fail-closed at `strict` until its equivalent
  private-state-denying profile wrapper is delivered.

## Validation

- `pnpm typecheck` and `pnpm build` passed.
- The canonical Electron suite passed: 776 files and 5,181 tests passed, with one existing skipped
  file/test and zero failures.
- `pnpm verify:linux-headless` and `pnpm verify:macos-worker-sandbox` passed.
- Full, Relay, Manager, and Feishu static checks, all scoped shell syntax checks,
  `git diff --check`, the empty-index check, and the changed TypeScript/TSX 500-line guard passed.
- Focused authority coverage proves Desktop and Feishu resolve the same nested Workspace directory
  while a symlink into adjacent Worker-private state is rejected before provider creation.

## Evidence Limits

- The existing live Mac Worker -> Relay -> Codex smoke was not restarted during this closure; the
  running Worker, Relay, and unrelated server service were deliberately left untouched.
- The macOS bookmark/provider canary proves model-facing Workspace read/write and outside denial,
  but the trusted Worker/Core broker is not itself App Sandbox-confined in this revision.
- Agent Deck-owned remote Browser/MCP/worktree brokerage, Grok profile parity, real Full
  Podman/Quadlet acceptance, and live credentialed Feishu acceptance remain open work and are not
  claimed by this record.

## Do Not Split Protection

No changed ordinary TypeScript or TSX file exceeds 500 lines. The largest changed file is
`src/main/remote-host/service.ts` at 498 lines; revisit before adding another responsibility.
