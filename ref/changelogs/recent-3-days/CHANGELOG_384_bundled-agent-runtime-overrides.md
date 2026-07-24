---
changelog_id: 384
changed_at: 2026-07-23
---

# CHANGELOG_384_bundled-agent-runtime-overrides: Configure bundled Agent runtimes

## Summary

The Assets Library now lets users override the model and thinking level of built-in Agents without
editing packaged prompt assets. Codex built-in Agents can additionally select a native
`model_provider`. Every adapter continues to own its native provider configuration, and restoring
defaults deletes the app-level override so the packaged Agent definition becomes authoritative
again.

## Changes

### Immutable built-in Agent overrides

- Added a typed, bounded `adapter:name` override store for bundled Agents. User and project Agents
  never consult this store.
- Exposed model and adapter-valid thinking controls for all built-in Agents, plus a Codex-only
  provider control with suggestions read from `~/.codex/config.toml` and unrestricted free-text
  entry for valid native provider ids.
- Kept packaged assets immutable. Save persists only fields that differ from the packaged Agent;
  Restore Default deletes the whole override record instead of rewriting or copying an asset.
- Displayed packaged defaults and active overrides in bundled-asset metadata while retaining the
  unmodified parsed asset cache as the source of truth.

### Runtime resolution

- Applied bundled-Agent overrides only after the resolver confirms the selected Agent came from
  Agent Deck's packaged assets.
- Preserved precedence as explicit spawn model/thinking, then app override, then packaged Agent
  default, then the adapter's native default.
- Applied Codex provider overrides through the native `model_provider` config override rather than
  inferring providers from model names.
- Synchronized final Claude/Deepseek model and effort values into both the outer SDK options and
  the active `AgentDefinition`, preventing an Agent definition from defeating an explicit spawn
  override.
- Set the bundled Grok reviewer default to `grok-4.5` with `high` effort. Existing Claude,
  Deepseek, and Codex packaged defaults are unchanged.

### Native configuration ownership

- Added a read-only parser for Codex `[model_providers.<id>]` entries and top-level
  `model_provider`; it never writes `~/.codex/config.toml`.
- Documented that Claude, Codex, and Grok each own their respective native backend/provider
  configuration. Agent Deck stores only the selected provider id for a bundled Codex Agent.
- Left user assets, user-level native configuration, and packaged plugin resources untouched.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 342 files and 2,986 tests; one opt-in test remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- `grok plugin validate resources/grok-config/agent-deck-plugin` passed.
- An isolated development instance initialized Claude, Deepseek, Codex, and Grok, mounted MCP,
  listened on an alternate hook port, displayed the window through `ready-to-show`, and shut down
  cleanly without disturbing the installed Agent Deck instance.
- Prompt inventory, pre-edit backups, check-only hashes, local documentation links, review expiry,
  and changed-source file-size checks passed.

## Do Not Split Protection

- All changed and new production source files remain at or below 500 lines.
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts` is exactly 500 lines; this change only routes
  already-resolved runtime inputs and does not add a separable responsibility.
- The largest changed test,
  `src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`, is 496 lines.

## Related records

- `PLAN_17_bundled-agent-runtime-overrides.md`
- `REVIEW_168_bundled-agent-runtime-overrides.md`
