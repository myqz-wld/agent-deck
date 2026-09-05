# User Custom Points

Keep the live Agent Deck host under exact user lifecycle authorization. The existing instruction-assets-only preference keeps runtime conventions focused on task behavior. No custom point was added by this one-time edit. Skill Market has no stored custom points.

## Authorization and scope

The user explicitly requested the model suggestions/defaults and three native Skill model tables. The later clarification restricted the table change to model cells; criteria, complexity rules, review thresholds and effort remain byte-identical. The existing model/effort instructions supplied scope and change approval without repeating a permission gate. No deep-review/simple-review or delegation was used.

Agent Deck editable prompt surfaces: README.md, src/main/agent-deck-mcp/tools/schemas/target-runtime.ts, and src/main/agent-deck-mcp/tools/schemas/spawn.ts. Runtime convention counterparts were checked only. Skill Market editable prompt surfaces: three skills/<adapter>/parallel-tasks/SKILL.md files and catalog/entries.json; skills/INDEX.md is generated. Descriptions and frontmatter are unchanged. No pitfall note, execution instruction, permission or sandbox policy changed.

## Inventory and backups

Both owning checkouts have fresh seven-day inventories at .prompt-asset-improver/local/inventory.json. Changed hashes were refreshed and validated. Each checkout stores its pre-edit backup at .prompt-asset-improver/local/backups/20260905T044945Z/manifest.json. Original backup hashes were checked. The private directories were already ignored. To restore, verify the manifest hash, inspect subsequent edits, and copy the selected backup_path to original_path within the same owning checkout. No installed assets were edited.

## Package preparation

Skill Market used its canonical CLI with a dedicated ignored SKILL_MARKET_HOME and SKILL_MARKET_CONFIG, the exact sibling checkout as repoPath, and main as baseRef. No global market state or network was used.

- Proposal: proposal-b0147e8537e6727b, prepared locally; no submit.
- Base: eca6a1c99fcebc9903df2104942a3af20392e976.
- Private prepared commit: eb368aaeacf936b2e5cfbf25ab4a7b05ff5379dc.
- Prepared binary/full-index diff SHA-256: fc56d13655f1f53b606e9ad00e3b825661d747290eabfcb05c00f86ebcf779a8.
- Three explicit standalone targets, 0.0.11 -> 0.0.12; five changed checkout paths.
- The verified prepared diff was inspected, checked, and applied to the sibling checkout with its original HEAD/index preserved. The private proposal is retained as local preparation provenance, with no external submission.

## Commands and results

- Agent Deck: mise exec -- pnpm typecheck — architecture and Node/Web checks passed.
- Agent Deck: mise exec -- pnpm run test <12 exact paths in focused-tests.txt> --maxWorkers=1 --minWorkers=1 — 149 passed.
- Skill Market: mise exec -- npm run validate — catalog views, packaged bundles and 149 tests passed.
- Skill Market: mise exec -- python3 $CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py skills/<adapter>/parallel-tasks — valid for claude, codex and grok.
- Both checkouts: git diff --check — passed. New source-file whitespace was checked separately.
- All local Markdown links in the edited README and Skill files resolve. Model-cell edits add no resource/external links. External model access was not queried.
- SQLite binding before/after: 463d208825f4d2660f4ec14181563c4b2ddbfeb779584c9b3251f0d7aafb2c67.

The focused schema case was relocated rather than duplicated. No low-impact model-string tests were added. This follow-up does not repeat the preceding full application suite/build; no new source failures or unresolved validation concern required expansion. No live provider, Browser, host lifecycle, installed-skill update, publication or checkout commit/push was performed.

## Official quota correction

OpenAI Docs fetched https://learn.chatgpt.com/docs/pricing on 2026-09-04 local time. It lists Astra usage estimates and consumption rates without stating a separate Astra quota pool, and explicitly describes Spark's separate limit. REVIEW_270 and PLAN_49 now distinguish the tested generic multi-quota projection from the unsupported prior account-specific claim. No account payload was read, and the original Data panel symptom remains unconfirmed.
