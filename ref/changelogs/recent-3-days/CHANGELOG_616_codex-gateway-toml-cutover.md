---
changelog_id: 616
changed_at: 2026-08-17
---

# CHANGELOG_616_codex-gateway-toml-cutover: Cut Codex selection over to Gateway TOML

## Summary

Codex runtime selection now mirrors the Claude Gateway abstraction. Agent Deck discovers only
`${CODEX_HOME:-~/.codex}/gateways/*.toml`, displays each filename stem, and treats the selected file
as a complete native Codex configuration. The former `config.toml` model-provider catalog and JSON
capacity-profile paths were removed without compatibility or migration behavior.

## Changes

### Gateway contract

- Enumerate safe `.toml` filename stems without parsing file contents; `xaminim.toml` is displayed
  and persisted as Gateway id `xaminim`.
- Parse a selected file as complete TOML with `@iarna/toml`, preserve nested native configuration,
  and fail closed for missing files, unsafe ids, malformed TOML, non-JSON-RPC values, invalid
  reasoning levels, or inconsistent context/compaction capacities.
- Keep `model`, `model_provider`, and `model_providers` optional. The public Gateway id is independent
  of top-level `model_provider`; when present, that internal value is passed through app-server
  `modelProvider` so its matching provider table is loaded.
- Empty selection delegates to ordinary Codex configuration. A selected Gateway never falls back
  through Agent Deck's removed `config.toml` provider discovery or borrows its model/thinking
  defaults.

### Runtime and safety

- Apply the same complete Gateway config to new, resumed, recovered, forked, summary, and checkpoint
  Codex threads on Desktop and Server Core.
- Preserve explicit model/reasoning/session settings and custom-Agent configuration above the
  Gateway layer while restoring only Agent Deck's reserved MCP entry as application-owned config.
- Keep approval, sandbox, internal no-tool/no-network isolation, and Server Core workspace ceilings
  authoritative after Gateway resolution.
- Remove the native provider discovery module and its tests; public/internal persisted `provider`
  field names remain protocol/storage names whose Codex value is now always a Gateway stem.

### UI, Remote, and documentation

- Rename Codex-facing “模型来源” presentation to “模型网关” and load the same stem-only catalog in
  new-session, handoff, live runtime, bundled-Agent, summary, and continuation settings surfaces.
- Project validated `.codex/gateways/*.toml` files unchanged into Remote provider homes, derive the
  version-3 safe session-create catalog only from their stems/model/reasoning/approval defaults,
  and stop advertising `config.toml` provider tables.
- Update MCP schemas, tool descriptions, recovery hints, README guidance, and bundled Codex
  instructions. The public MCP field remains named `provider`, but its documented value is a Codex
  Gateway id rather than native `model_provider`.
- Add `@iarna/toml` as a direct runtime dependency.

## Validation

- Codex 0.147.0 app-server protocol probes verified full thread config and independent native
  `modelProvider` selection.
- Focused Gateway parser, lifecycle, thread-layer, Remote projection, MCP, and renderer tests passed.
- `pnpm typecheck`
- `pnpm test` (final rerun after the two updated expectations)
- `pnpm build`
- Prompt-asset inventory, backup manifest/original hashes, refreshed hashes, counterpart checks,
  Markdown links, and `git diff --check` validated.

## Do Not Split Protection

All changed production TypeScript files remain at or below 500 lines. The largest touched prompt
registry remains 445 lines, the Remote projection is 376 lines, and the complete Gateway parser is
270 lines. No new mixed-responsibility file crossed the project split threshold.

## Notes

This hard cut supersedes `CHANGELOG_615_codex-gateway-capacity-profiles.md`. Existing JSON capacity
profiles are intentionally ignored and are not migrated. Users must author complete same-named TOML
Gateway files when they want those selections to remain available.

The ten confirmed prompt/documentation assets were backed up before editing under
`.prompt-asset-improver/local/backups/20260817T083732Z/` with a verified manifest.
