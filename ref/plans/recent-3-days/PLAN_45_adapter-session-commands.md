---
plan_id: 45
completed_at: 2026-08-27
status: completed
---

# PLAN_45_adapter-session-commands: Integrate native adapter slash commands

## Goal

Expose the slash commands that each live provider adapter can faithfully execute in Agent Deck,
including adapter-aware completion in Local and Remote composers.

## Invariants

- Provider commands are discovered from the provider-owned runtime when an API exists.
- A slash command is never simulated as a model prompt when the provider exposes a dedicated
  control operation.
- Codex `/compact` uses `thread/compact/start`; Codex `/clear` starts a fresh native thread while
  preserving the stable Agent Deck session id and durable activity timeline.
- Command metadata crossing IPC or remote transport is bounded and JSON-safe.
- Unsupported slash text retains the existing ordinary-message behavior.
- Commands do not bypass handoff, worktree-transition, attachment, or active-turn ordering gates.
- Local and Server Core expose the same adapter command catalog.

## Scope and exclusions

The completed scope includes shared contracts, adapter catalogs for Claude Code, Codex CLI, and
Grok Build, Codex native control execution, Claude reset identity handling, Local and Remote
transport, shared composer suggestions, protocol versioning, documentation, and tests. TUI-only
pickers such as Codex `/model`, `/theme`, and `/status` remain excluded until Agent Deck can preserve
their native interaction semantics.

## Decisions

- Claude and Grok command lists remain dynamic. Claude keeps host fallbacks for `/clear` and
  `/compact`, which are explicit SDK lifecycle events.
- Codex advertises only `/clear` and `/compact` in this stage because app-server provides the
  required native boundaries for those operations.
- The existing `session.input.capabilities` response carries Remote command metadata, avoiding a
  second live-session read method.

## Completed work

- [x] Locate adapter, IPC, Server Core, and composer boundaries.
- [x] Add bounded command contracts and adapter catalogs.
- [x] Implement provider command discovery and Codex control execution.
- [x] Add Local and Remote composer suggestions.
- [x] Add lifecycle, transport, and renderer tests.
- [x] Update the protocol, README, plan archive, and changelog.

## Validation

- Focused Vitest suite: 20 files / 93 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,015 files passed and 2 skipped; 6,327 tests passed and 3 skipped.
- `pnpm build`
- `git diff --check`

## Final status

Completed. Additional interactive Codex TUI commands remain a separate future stage because they
require host-native picker and modal semantics rather than text forwarding.

## Related final record

- `ref/changelogs/recent-3-days/CHANGELOG_631_adapter-session-commands.md`
