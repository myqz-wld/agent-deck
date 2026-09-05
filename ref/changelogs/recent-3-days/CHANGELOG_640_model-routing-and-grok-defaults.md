---
changelog_id: 640
changed_at: 2026-09-04
---

# Model suggestions, Grok defaults, and parallel-task references

## Summary

Spawn/handoff now suggest `gpt-6-astra` and `grok-4.6` alongside the existing model names.
Unconfigured Grok creation defaults use `grok-4.6`. The sibling Skill Market's three
`parallel-tasks` packages update only their four reference-model cells.

## Changes

- The shared Desktop spawn/handoff description and spawn example array retain the Claude aliases,
  all three GPT 5.6 variants, and Grok 4.5 while adding the two requested names. Model validation
  remains free text; explicit runtime arguments, Agent defaults, inherited values, and native
  configuration keep their existing precedence. Reasoning settings are unchanged.
- Grok's fallback model is 4.6 in the local defaults resolver, renderer fallback, Server Core
  catalog, and provider-home projection. The container broker config and display name also default
  to 4.6; its advertised local model catalog adds 4.6 while retaining 4.5. Configured model selections
  are not migrated or overwritten.
- The README records the new default and free-text suggestion contract. Existing default and
  schema assertions were updated; the independent schema test was extracted from the oversized
  MCP integration suite while preserving its previous assertions.
- Skill Market explicitly updates the Claude, Codex, and Grok standalone packages from 0.0.11 to
  0.0.12 and regenerates the catalog views. As clarified by the user, only model cells change:

  | Tier | Reference model | Effort |
  |---|---|---|
  | T1 | `gpt-6-astra` | `xhigh` |
  | T2 | `fable` | `xhigh` |
  | T3 | `gpt-5.6-sol` | `xhigh` |
  | T4 | `opus` | `xhigh` |

  Each tier's criteria, dispatch complexity classification, review thresholds, approval rules,
  adapter-family routing, and all other Skill bytes remain unchanged. The removed reference target
  is Terra; the four-tier structure is preserved.
- REVIEW_270 and PLAN_49 now explicitly correct the earlier unsupported claim of an Astra-only
  allowance. [Official pricing](https://learn.chatgpt.com/docs/pricing) lists Astra estimates/rates
  without establishing a separate Astra quota pool. Existing generic multi-quota code is preserved;
  the original unspecified Data panel symptom is still unconfirmed.

## Validation

- Agent Deck: `pnpm typecheck` passed, including architecture checks and Node/Web compilation.
- Focused Electron-wrapper validation: 12 files / 149 tests passed, covering MCP contracts, native
  configuration precedence, Core projection, shim config/proxy, UI fallbacks, and reviewer defaults.
- Skill Market: `mise exec -- npm run validate` passed all catalog/bundle checks and 149 tests.
  All three standalone Skills passed the installed Skill validator.
- Byte comparison against backups confirms only the four model cells changed per Skill. Catalog
  versions and generated views match the three explicit package targets. Backup hashes, refreshed
  inventories, local Markdown links, and both checkout diffs passed validation.
- SQLite binding SHA-256 is unchanged. No new tests were skipped, dependencies installed, or native
  binaries rebuilt. This bounded follow-up did not repeat the earlier full app suite/build and does
  not claim a live provider or installed-host smoke test.
- [Validation evidence](model-routing-defaults/validation.md) records commands, source hashes,
  prompt-asset checks, and the local proposal provenance. [PLAN_50](../../plans/recent-3-days/PLAN_50_model-routing-and-grok-defaults.md)
  records the completed authorized scope.

## Do Not Split Protection

`src/main/agent-deck-mcp/__tests__/tools.test.ts` was reduced from 2,850 to 2,787 lines by moving the
independent schema case into a 72-line focused file. Its remaining integration cases share the
existing mocked transport/store setup. A broader suite decomposition would change unrelated test
ownership; revisit when that integration harness changes. All other changed source files are below
500 lines.

## Delivery boundaries

The requested checkouts retain their prior HEADs and indexes. Skill Market's repository-owned
proposal workflow created a private prepared commit, whose verified bounded diff was applied to the
sibling checkout; nothing was submitted or pushed. Installed Skills and the running Agent Deck app
were not changed. Main-process defaults and tool descriptions take effect in the next approved
restart/release; this task performed no host lifecycle action.

The required date-bucket scan also moved REVIEW_215 into history; its content is unchanged.
