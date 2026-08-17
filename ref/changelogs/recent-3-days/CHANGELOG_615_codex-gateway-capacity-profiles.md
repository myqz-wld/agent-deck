---
changelog_id: 615
changed_at: 2026-08-16
---

# CHANGELOG_615_codex-gateway-capacity-profiles: Add Codex Gateway capacity profiles

## Summary

Agent Deck can now pair each native Codex `model_provider` with an optional
`${CODEX_HOME:-~/.codex}/gateways/<provider>.json` profile. The selected provider's context window
and automatic-compaction threshold are applied through app-server thread configuration, without
changing the whole app-server process or affecting Claude Gateway profiles.

## Changes

### Profile contract

- Added a host-neutral parser and desktop filesystem host for Codex Gateway profiles under
  `${CODEX_HOME:-~/.codex}/gateways/`.
- Match the JSON filename to the exact native `model_provider` id and project only
  `model_context_window` and `model_auto_compact_token_limit` into Codex configuration.
- Require supported values to be positive safe integers and reject a compaction limit above the
  context window. Missing profiles preserve native Codex defaults; malformed matching profiles
  fail before a thread starts.
- Ignore unrelated profile metadata so credentials or arbitrary Codex configuration cannot enter
  the thread layer. Native providers outside the safe filename form remain usable without a
  file-backed profile.

### Thread-level configuration

- Resolve the profile after explicit or persisted provider selection and pass it to new, resumed,
  and forked Codex app-server threads.
- Apply the provider profile after inherited base configuration and before selected Codex Agent
  overrides, preserving the existing explicit Agent configuration precedence.
- Apply the same capacity layer to isolated internal Codex one-shot threads while retaining their
  no-network, no-MCP, no-plugin, and ephemeral controls.
- Keep profile discovery behind injected desktop and Server Core hosts, with a Node-free parser
  protected by architecture and bundle gates.

### Remote projection and documentation

- Project `.codex/gateways/*.json` into Remote provider homes using only the two supported numeric
  keys, remove stale projected profiles, and keep Claude `.claude/gateways` projection unchanged.
- Document the profile path, JSON shape, matching rule, validation, precedence, and non-writing
  boundary in `README.md` and `resources/README.md`.

## Validation

- Official OpenAI app-server documentation confirmed thread start/resume configuration overrides;
  the configuration reference confirmed both capacity keys and their meanings.
- Focused profile, thread-layer, create/resume, fork, one-shot, and Remote projection coverage:
  10 files / 43 tests passed.
- Post-split app-server coverage: 2 files / 16 tests passed.
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Prompt-asset inventory, backup manifest, original hashes, refreshed hashes, and local Markdown
  links validated.
- `git diff --check`
- The development-process restart was skipped at the user's explicit request; the existing Agent
  Deck listener on `127.0.0.1:47821` was left running and untouched.

## Do Not Split Protection

All changed production TypeScript files are at or below 500 lines; the Codex bridge facade is
exactly 500 lines. The new app-server test was split from `client.test.ts` to keep that file below
the limit. `scripts/check-architecture-boundaries.mjs` and `scripts/check-core-node-boundaries.mjs`
remain above 500 lines because they are centralized declarative rule registries whose ordering and
single-pass execution are the current source of truth. Revisit splitting them when the checker
framework gains a shared rule-loader abstraction or either file next requires non-declarative
behavior.

## Notes

The confirmed documentation assets were backed up under
`.prompt-asset-improver/local/backups/20260817T043808Z/`. Restore either file by copying its
manifest-named backup over the corresponding repository path.
