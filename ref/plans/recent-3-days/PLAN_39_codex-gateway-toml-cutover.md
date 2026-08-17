# PLAN_39_codex-gateway-toml-cutover: Codex Gateway TOML hard cut

Status: completed
Completed At: 2026-08-17
Base commit: `b4549ccad2c6d7612f1c3217676b5030a9b9a385`
Related final record: `CHANGELOG_616`

## Goal

Replace Agent Deck's Codex `config.toml` model-provider discovery and the JSON capacity overlay with
the same file-backed Gateway abstraction exposed for Claude: enumerate filename stems, select one
complete native config file, and use that selection consistently across Local, Remote, lifecycle,
and internal model calls.

## Context and constraints

- Codex Gateways are discovered only from `${CODEX_HOME:-~/.codex}/gateways/*.toml`.
- The filename stem is the public id and display name; contents are not parsed during enumeration.
- A selected file is a complete ordinary Codex TOML config. `model`, `model_provider`,
  `model_providers`, reasoning, approval, capacity, and other native keys are optional.
- Top-level `model_provider`, when present, is independent of the filename and is passed through
  app-server `modelProvider` so the matching provider table is selected.
- Empty selection delegates to native `config.toml`; non-empty selection must resolve to the exact
  same-named TOML file and never falls back to provider discovery.
- Agent Deck's reserved MCP server, explicit runtime controls, internal isolation, and Server Core
  workspace boundary remain authoritative.
- No JSON compatibility, config-provider catalog merge, automatic profile creation, or selector
  migration is allowed.

## Task breakdown

- [x] Replace provider discovery with safe `.toml` stem enumeration and strict full-TOML parsing.
- [x] Route create, resume, recovery, fork, summary, checkpoint, and Server Core through one Gateway
  resolver while keeping native `modelProvider` separate from the public Gateway id.
- [x] Stop Agent Deck model/provider/thinking defaults from falling back to `config.toml` after a
  Gateway is selected.
- [x] Project complete validated TOML files to Remote provider homes and derive the versioned safe
  catalog from Gateway files only, including model, reasoning, and approval defaults.
- [x] Rename visible Codex selection copy to 模型网关 and align all Local/Remote selectors.
- [x] Update MCP schemas/descriptions, bundled Codex instructions, README documentation, tests, and
  the direct TOML parser dependency.
- [x] Remove the old provider discovery module and JSON profile tests.

## Validation

- Codex 0.147.0 app-server protocol probes for complete config and native `modelProvider` loading.
- `pnpm typecheck`
- `pnpm test`: 970 files passed, 2 intentionally skipped; 6,131 tests passed, 3 skipped.
- `pnpm build`
- Focused Gateway/Remote regression tests after the catalog v3 approval-default addition.
- Prompt inventory and refreshed hashes, ten-file backup manifest/original hashes, counterpart
  parity, Markdown paths, file-size limits, and `git diff --check`.

## Final status / handoff

The hard cut is complete. Existing `${CODEX_HOME}/gateways/*.json` files are ignored by design.
Users should author complete `${CODEX_HOME}/gateways/<id>.toml` files; `provider` remains only the
public API/storage field name for that Gateway stem. `CHANGELOG_616` is the final behavior record.
