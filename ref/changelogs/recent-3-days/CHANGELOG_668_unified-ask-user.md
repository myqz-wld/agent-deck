---
changelog_id: 668
changed_at: 2026-09-30
---

# Unified questions in Pending

## Summary

Claude, Codex, and Grok can use `ask_user` to place related questions in Pending and receive
structured answers. Users can find and answer questions without searching the conversation.

## Changes

- Expose the same question schema, description, and structured result through Local and Server Core
  MCP. Accept one to four questions with optional choices, multiple selection, free text, and notes.
- Reuse existing question cards, pending hydration, and answer IPC. Local questions have a
  provider-independent service; Remote questions use Core's presentation queue and authority.
- Wait without an application timer while the call remains live. Reject cross-session answers,
  invalid selections, duplicate responses, and external MCP callers. Cancel unresolved requests on
  transport cancellation, session closure, or handoff; preserve provider session-id normalization.
- Publish answered events to remove cards across renderer stores, resume session activity, and
  avoid duplicate waiting notifications. Blank entries remain unanswered and are never approval.
- Align the three bundled runtime prompts to use `ask_user` for needed clarification and choices.
  Native permission controls, plan/diff approval gates, and fallback question tools retain their roles.
- Update the MCP settings description and expandable inventory to include `ask_user`, explain
  Pending answers, and show the correct total of 20 core tools.

## Validation

- `pnpm typecheck`: passed, including architecture checks.
- `pnpm test`: 6,946 passed, six existing skips. An initial run inherited a temporary `umask 077`,
  affecting permission fixtures; rerunning with the original `022` passed.
- Final focused run: 80 passed across nine files, including the last session-rename, display,
  notification, and real MCP cancellation checks.
- `pnpm build`: passed for the MCP implementation before the settings-copy follow-up.
- Settings-copy follow-up: `pnpm typecheck` and the existing MCP settings component test passed.
- `git diff --check`, changed source line limits, prompt parity, local links, and machine-path
  checks: passed. No package was distributed and no live instance was restarted or replaced.

## Prompt Asset Report

User Custom Points: none.

The user confirmed the proposed scope and change list in this conversation. Confirmed assets:

- `resources/claude-config/CLAUDE.md`, `resources/codex-config/CODEX_AGENTS.md`, and
  `resources/grok-config/GROK_AGENTS.md`: add the same question-routing rule under Plans And User
  Presentation. Provider-specific injection, permissions, and recovery rules remain intact.
- `src/main/agent-deck-mcp/tools/schemas/ask-user.ts`: publish when to ask, input/output limits,
  ownership, cancellation, and recovery behavior.
- `src/main/agent-deck-mcp/tools/index.ts` and
  `src/hosts/server-core/mcp-presentation-tools.ts`: register that shared contract on both hosts.

The private inventory uses a seven-day expiry and refreshed content hashes. Changed prompt sections
match across adapters, and local links resolve. No skill metadata, catalog rows, external links, or
pitfall notes were changed. No confirmation gate was skipped.

## Do Not Split Protection

None. All changed source files remain below 500 lines; new tests live in focused files.

## Runtime Activation

Main-process changes require loading this build and restarting Agent Deck before the new MCP tool
is available. New or refreshed provider sessions must load the updated bundled instructions.
Live runtime activation remains a separately authorized action.

Related plan: [PLAN_77](../../plans/recent-week/PLAN_77_unified-ask-user.md).
