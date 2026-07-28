---
plan_id: PLAN_21
title: Grok Build native sandbox controls
status: completed
created_at: 2026-07-27
updated_at: 2026-07-27
completed_at: 2026-07-27
base_branch: main
base_commit: ebfc62ff3fb9cd16a6f8bdb16c6de7332544d716
related_changelog: CHANGELOG_405
---

# PLAN_21_grok-native-sandbox-controls: Complete native sandbox parity

## Goal and invariants

- Expose Grok Build's native sandbox everywhere Agent Deck can create, recover, or hand off a Grok
  session.
- Preserve Grok-native behavior when no Agent Deck override is selected.
- Keep sandbox constraints separate from ACP permission decisions and Grok work modes.
- Persist the requested profile without claiming it is the effective enterprise-managed value.
- Switch an existing session only while idle, retain its Agent Deck/native identity and queue, and
  recover the old profile when the requested child cannot start.
- Reject foreign adapter controls and invalid custom profile names at every public boundary.
- Keep all changed/new production TypeScript files at or below 500 lines.

## Mechanism and decisions

1. Grok Build owns the sandbox capability. Its native CLI supports five built-ins plus named
   profiles from `~/.grok/sandbox.toml` and project `.grok/sandbox.toml`.
2. ACP v1 has flexible agent-advertised config options but no hard-coded sandbox field. Grok
   0.2.111 returned `configOptions: []` for both `session/new` and `session/load`, so Agent Deck
   cannot rely on `session/set_config_option` for sandbox switching.
3. Each Agent Deck Grok session already owns one ACP child. The profile is therefore applied as
   `grok --sandbox <profile> agent --no-leader stdio`.
4. `settings.grokSandbox = null` means no app-level CLI override. This preserves native config,
   environment, and managed-requirement precedence for existing users.
5. A live switch is a single-flight child replacement: stop, start with the target, load the
   existing native session, then persist. Failure starts the old profile and reloads before
   returning an explicit rollback error.
6. The stored/UI value is a requested profile. Managed requirements can override it, and current
   ACP responses provide no effective-policy attestation.

## Completed work

| Area | Result |
|---|---|
| Shared contract | Built-in/custom profile validation and adapter ownership |
| Settings/storage | Nullable default plus v053 per-session persistence |
| Launch/recovery | Native process argument, resume, rename, and continuation coverage |
| Live switching | Idle guard, queue pause, single-flight restart, rollback, and fatal dual failure |
| Public APIs | IPC, preload, CLI, MCP spawn/handoff, team review, and Issue resolution |
| Renderer | Global/create/handoff/Issue pickers and live requested-profile control |
| Documentation | README usage, inheritance semantics, and managed/macOS boundaries |
| Prompt assets | Codex/Claude/Grok and MCP descriptions aligned; review skills checked unchanged |
| Structure | IPC and turn-queue responsibilities extracted below the 500-line guardrail |
| Records | Changelog and completion-date plan rebucketing/index maintenance |

## Validation performed

- `pnpm typecheck` passed.
- Electron-ABI `pnpm test` passed 396 files / 3,318 tests, with one opt-in credentialed Codex
  smoke skipped.
- `pnpm build`, `pnpm logger:check`, Grok plugin validation, and whitespace checks passed.
- Targeted tests cover parsing, argv ordering, settings invalidation, migration/rename continuity,
  create/handoff inheritance, foreign-field rejection, active/pending guards, success, rollback,
  dual failure, same/different concurrent requests, queue retention, and renderer confirmation/
  custom/busy states.
- Real Grok Build 0.2.111 completed no-model ACP initialize/new/restart/load under `strict`;
  it returned no dynamic config options and rejected a nonexistent custom profile before ACP
  initialization.
- An isolated built Electron instance migrated through v053, initialized the adapters, mounted MCP
  and an alternate-port hook server, loaded preload/renderer, and displayed the window.
- Prompt inventory and backup hashes matched their manifests; the Grok reviewer plugin validated.
- Changed/new production TypeScript files are all at or below 500 lines.

## Residual boundaries

- macOS does not enforce Grok's child-network restriction for `read-only` or `strict`; Agent Deck
  states this platform boundary in the UI.
- Built-in profiles do not permanently deny every credential path; custom profiles remain the
  mechanism for organization-specific deny lists.
- Agent Deck cannot display an effective managed sandbox until Grok exposes that state through ACP
  or another machine-readable interface.
- Switching intentionally refuses to interrupt an active turn or unresolved permission request.

## Support materials

- Behavior record:
  `ref/changelogs/recent-3-days/CHANGELOG_405_grok-native-sandbox-controls.md`.
- Prompt inventory:
  `.prompt-asset-improver/local/inventory.json` (ignored implementation-worktree record).
- Pre-edit restore manifest:
  `.prompt-asset-improver/local/backups/20260728T040629Z/manifest.json` (ignored
  implementation-worktree record; base commit above is the durable restore source).
- Agent Deck task: `a4a6e0c7-dbf3-4ded-94bf-b048ecfe34fd`.
