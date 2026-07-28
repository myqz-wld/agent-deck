---
changelog_id: 405
changed_at: 2026-07-27
---

# CHANGELOG_405_grok-native-sandbox-controls: Control Grok's native sandbox

## Summary

Agent Deck now exposes Grok Build's native process sandbox across settings, new sessions, CLI,
MCP spawn, hand-off, Issue resolution, recovery, and live idle-session controls. Grok profiles are
passed to the ACP child as `grok --sandbox <profile> agent --no-leader stdio`; Agent Deck no longer
treats the absence of a standardized ACP sandbox field as an absence of Grok sandbox capability.

The built-in `off`, `workspace`, `devbox`, `read-only`, and `strict` profiles are available, along
with validated custom names from user or project `sandbox.toml`. The UI reports the requested
profile rather than claiming it is the effective enterprise-managed policy.

## Changes

### Native process and session lifecycle

- Add a shared open-string Grok sandbox contract with trimmed 1-128 character names, built-in
  profile helpers, and control-character rejection.
- Preserve compatibility with Grok-native configuration: a `null` app setting or omitted
  per-session value adds no `--sandbox` argument.
- Insert `--sandbox <profile>` before Grok's `agent` subcommand while retaining positional argv
  transport through the login-shell launch path.
- Persist the requested profile in migration v053 and carry it through create, resume, recovery,
  rename, continuation fingerprints, and target snapshots.
- Add a single-flight idle-session restart controller. It pauses queue drain, stops only the
  session's ACP child, starts the requested profile, and reloads the existing native session.
  Persistence happens only after success.
- If the requested child fails, automatically restart and reload with the old profile. If both the
  requested start and rollback fail, close the unusable runtime with diagnostics from both errors.
- Reject switching during an active turn, message submission, or pending ACP permission request;
  late permission requests are cancelled while a sandbox restart is in progress.

### Public entry points and ownership

- Add `grokSandbox` to app settings, session records, adapter capabilities, runtime profiles, and
  the adapter-owned runtime-control contract.
- Support the field in renderer IPC/preload, `agent-deck new --grok-sandbox`, MCP
  `spawn_session`, `hand_off_session`, team/deep-review spawn paths, and Issue
  “resolve in new session”.
- Apply precedence as explicit request, same-adapter source session, Agent Deck Grok default, then
  Grok-native configuration. Cross-adapter inheritance is rejected.
- Keep `sessionMode` and ACP permission requests independent from the OS sandbox. Grok continues
  rejecting Claude/Codex permission, sandbox, and writable-root fields.

### Renderer

- Add one Grok profile picker with built-in choices, native-follow mode, and custom profile input.
- Surface the control in global settings, new-session, hand-off, and Issue-resolution dialogs.
- Add a live session control labelled as the requested profile. It disables while the session is
  busy, requires confirmation before selecting `off`, and displays switch/rollback failures.
- Explain managed-policy precedence and the macOS child-network limitation without overstating the
  effective sandbox.
- Document the supported profiles, native-follow behavior, CLI entry point, and platform boundary
  in the project README.

### Prompt assets and structure

- Align the Codex, Claude, and Grok bundled instructions plus MCP tool/field descriptions with the
  process-start sandbox contract and adapter ownership.
- Verify the Grok simple/deep review skills as check-only counterparts; their explicit-override
  guidance remains correct and unchanged.
- Extract sandbox restart IPC registration and Grok turn-queue helpers so every changed or new
  production TypeScript file remains within the repository size guardrail.
- Rebucket final plan records according to their completion dates while adding the completed plan
  for this delivery.

## Validation

- `pnpm typecheck` passed.
- Electron-ABI `pnpm test` passed 396 files and 3,318 tests; one opt-in credentialed Codex smoke
  remained skipped.
- `pnpm build`, `pnpm logger:check`, `grok plugin validate
  resources/grok-config/agent-deck-plugin`, and `git diff --check` passed.
- Real Grok Build 0.2.111 completed ACP `initialize`, `session/new`, process restart, and
  `session/load` under `strict` without sending a model prompt. Both session responses returned an
  empty `configOptions` list.
- Grok 0.2.111 rejected a nonexistent custom sandbox profile before ACP initialization with a
  fail-closed diagnostic; deterministic controller tests cover successful rollback and dual
  failure disposal.
- An isolated built Electron instance migrated a fresh database through v053, initialized all four
  adapters, mounted MCP and the hook server on an alternate port, loaded the preload/renderer, and
  showed the window before shutting down cleanly.
- Prompt inventory hashes, pre-edit backup hashes, manifest JSON, editable counterparts, and the
  two unchanged check-only Grok review skills were verified.
- Changed/new production TypeScript files are at or below 500 lines; the largest are the Grok
  bridge and MCP spawn handler at 497 lines.

## Do Not Split Protection

All changed and new production source files are at or below 500 lines. No protection exception is
required.

## Notes

- ACP v1 provides generic agent-advertised session config options, but no dedicated sandbox field.
  The installed Grok ACP agent advertises no config options, so a reliable switch requires a new
  process and native `session/load`.
- Grok managed requirements can override a CLI request and ACP does not currently report the
  effective sandbox. Agent Deck therefore stores and displays only the requested profile.
- On macOS, Grok documents child-network blocking for `read-only` and `strict` as a no-op; the
  filesystem sandbox still uses Seatbelt.
- The prompt-asset inventory and pre-edit backup were created and hash-verified under ignored
  `.prompt-asset-improver/local/` in the implementation worktree. The durable restore source after
  normal worktree cleanup is base commit `ebfc62ff3fb9cd16a6f8bdb16c6de7332544d716`.
- The completed implementation plan is
  `ref/plans/recent-3-days/PLAN_21_grok-native-sandbox-controls.md`.
