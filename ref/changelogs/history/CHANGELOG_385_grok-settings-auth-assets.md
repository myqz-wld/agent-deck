---
changelog_id: 385
changed_at: 2026-07-23
---

# CHANGELOG_385_grok-settings-auth-assets: Complete Grok settings and asset editing

## Summary

Grok Build now has a first-class Settings view, editable app conventions with built-in-only reset
semantics, `xhigh` thinking controls, and explicit ACP authentication before native session
creation or loading. GUI launches can inherit exported API-key variables through the user's login
shell without Agent Deck reading or storing their values.

## Changes

### Asset Library

- Renamed the bundled Agent action from **Runtime Configuration** to **Edit** while retaining the
  narrow model, thinking, and Codex-provider boundary.
- Replaced the native Codex provider datalist with an app-styled free-text combobox. Native custom
  provider ids remain valid and continue to be owned by `~/.codex/config.toml`.
- Added Grok Build to the Application Conventions view. Edits live in the app-owned
  `<userData>/agent-deck-grok-agents.md` copy and never modify `~/.grok`.
- Kept Restore Default limited to built-in assets: bundled Agent reset deletes its runtime delta,
  and each app-convention editor exposes reset only while an app-owned custom copy exists.
- Appended Grok conventions through ACP `_meta.rules` independently of `_meta.agentProfile`, so a
  named bundled Agent and the editable application convention remain active together.

### Grok runtime and authentication

- Added `xhigh` to Grok runtime profiles, session controls, bundled Agent editing, validation, and
  MCP tool descriptions. The packaged `reviewer-grok` default remains `grok-4.5` / `high`.
- Read ACP `authMethods` after initialization and call `authenticate` before `session/new` or
  `session/load`, preferring API-key authentication and falling back to cached login.
- Launch the real Grok child through a supported login shell on macOS/Linux. A dedicated file
  descriptor carries ACP JSON so shell startup output cannot corrupt the protocol stream.
- Kept authentication provider-native: Agent Deck neither accepts nor persists API keys and gives
  an actionable `grok login --oauth` / native `env_key` error when headless authentication fails.
- Added a no-prompt authentication probe to Settings. It reports the selected and advertised ACP
  methods without creating a Grok session or sending a paid model request.

### Settings and documentation

- Added a Grok Build Settings tab with native config ownership, ACP behavior, terminal-integration
  boundaries, and authentication diagnostics.
- Updated shared MCP, external-tool, reset, and adapter help copy to include the Grok execution
  model where relevant without inventing unsupported Grok terminal Hooks or summary providers.
- Documented native configuration ownership, app-owned convention copies, authentication flow,
  login-shell inheritance, and Grok thinking levels.

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 349 files and 3,001 tests; one opt-in test remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- A real Grok Build `0.2.110` no-prompt smoke authenticated through `cached_token` using the login
  shell. A second smoke created and then deleted a native session with both `_meta.rules` and the
  `reviewer-grok` named Agent profile.
- An isolated built Electron instance initialized all four adapters, mounted MCP, listened on
  port 47831, showed the renderer, and shut down without disturbing the installed app on 47821.
- Prompt backup manifests and check-only Claude, Codex, and Grok convention hashes matched; local
  documentation links, review expiry, and changed-source file-size checks passed.

## Do Not Split Protection

- All changed and new production source files remain at or below 500 lines.
- `src/main/adapters/grok-build/bridge.ts` is exactly 500 lines. This follow-up only marks the
  existing capability-probe child as initialize-only; authentication and shell launch remain in
  dedicated modules. The next production change that would exceed 500 lines must extract another
  bridge responsibility first.
- Large changed test files remain exempt from the production guardrail.

## Related records

- `CHANGELOG_383_grok-build-adapter-profiles.md`
- `CHANGELOG_384_bundled-agent-runtime-overrides.md`
- `REVIEW_169_grok-auth-asset-boundaries.md`
