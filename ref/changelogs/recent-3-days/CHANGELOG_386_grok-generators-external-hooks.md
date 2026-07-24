---
changelog_id: 386
changed_at: 2026-07-23
---

# CHANGELOG_386_grok-generators-external-hooks: Add Grok generators and terminal capture

## Summary

Grok Build can now generate periodic summaries and Continuation Context checkpoints through an
isolated official headless CLI turn. External terminal Grok sessions can be captured through a
native Grok Hook, while Agent Deck-managed Grok children remain ACP-owned and are deduplicated.

## Changes

### Grok summary and continuation generators

- Added Grok Build to the shared summary and Continuation Context provider selectors with
  provider-correct `low` through `xhigh` thinking validation.
- Added a bounded Grok headless oneshot runner using the configured Grok binary, the user's native
  authentication and `config.toml`, and an optional explicit model. A blank model continues to use
  the Grok configuration default, including user-defined model aliases.
- Hardened generator turns with a temporary private prompt file, one-turn execution, empty tools,
  explicit executable/MCP denies, strict sandboxing, disabled memory/subagents/web search, bounded
  output and diagnostics, timeout/abort process cleanup, and exact ephemeral-session deletion.
- Mapped current Grok JSON output, structured output, token usage, stop reasons, and provider
  errors into the existing summary and checkpoint contracts.

### External Grok terminal capture

- Added a native Grok Hook installer for user and project scope. Agent Deck owns only
  `~/.grok/hooks/agent-deck.json` or the corresponding project file, preserves unrelated content,
  writes atomically with private permissions, and removes only tagged entries.
- Added authenticated Hook routes and normalized translations for session, prompt, tool, failure,
  permission-denied, compact, notification, stop, and session-end events.
- Added Grok Hook capability, IPC/preload wiring, Settings controls, adapter help, and empty-session
  guidance. Captured sessions remain external/read-only; application sessions continue through ACP.
- Updated the README's session-source, adapter, generator, Settings, project-structure, and Hook
  validation sections to describe the native Grok channel and its ACP/headless ownership boundary.
- Marked every Agent Deck-managed Grok child as `sdk`, disabled Grok's Claude/Cursor compatibility
  scanners for those children, and retained the shared SDK-origin drop gate for native-hook
  fallback events.
- Added a Grok compatibility guard to newly generated Claude Hook commands. Existing legacy Agent
  Deck Claude Hook commands now report as needing reinstall so external Grok cannot be duplicated
  as a Claude session after migration.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 354 files and 3,025 tests; one opt-in test remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Hook unit tests cover private installation, user-content preservation, project scope, malformed
  input, selective uninstall, event translation, authenticated route metadata, and SDK/CLI origin
  tagging.
- Deterministic Grok headless tests cover argument isolation, current JSON output, structured
  output, timeout cleanup, and exact ephemeral-session deletion without sending a paid prompt.
- Local Grok Build `0.2.110` accepted the complete hardened headless argument set and stopped at an
  intentionally missing prompt file before session creation or model execution.
- An isolated dev restart initialized Claude, Deepseek, Codex, and Grok, mounted MCP, listened on
  port 47831, displayed the renderer, and shut down cleanly without interrupting the installed app.

## Do Not Split Protection

- All changed and new production source files remain at or below 500 lines.
- The Grok headless runner, Hook installer, route layer, and event translations are separate
  modules rather than additional responsibilities in the existing 500-line ACP bridge.
- `settings-store.ts` remains below the guardrail by extracting provider/thinking migration
  validation into a focused shared helper.

## Related records

- `CHANGELOG_383_grok-build-adapter-profiles.md`
- `CHANGELOG_384_bundled-agent-runtime-overrides.md`
- `CHANGELOG_385_grok-settings-auth-assets.md`
