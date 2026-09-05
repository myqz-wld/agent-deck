# Prompt asset validation

User Custom Points: preserve exact host-process approval; keep loading/injection mechanics out of model-visible application conventions. No convention or lifecycle rule was changed.

- Scope and replacement confirmation: the current user explicitly requested reviewer-codex default `gpt-6-astra` and reviewer-grok default `grok-4.6`, with thinking unchanged. This authorization was reused; no redundant confirmation or broader prompt rewrite was requested.
- Confirmed editable assets: `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml` and `resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md`, model metadata only.
- Check-only counterpart: `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`, retained as `opus` / `xhigh`.
- Backup: `.prompt-asset-improver/local/backups/20260905T035902Z/manifest.json`. Original hashes matched and the post-edit files equaled exactly the requested model-string replacement. Codex `xhigh`, Grok `high`, bodies, descriptions, permissions and protocol rules are unchanged.
- Inventory: `.prompt-asset-improver/local/inventory.json`, refreshed for the two confirmed assets and the check-only counterpart with a seven-day expiry and post-edit SHA-256 values. Private local state is ignored by Git. No new custom point was recorded for this one-time task.
- Validation: TOML/frontmatter parsing and existing bundled reviewer/paired runtime tests passed, followed by the full suite, typecheck and build. No changed Skill needed a Skill validator. Existing role resource references and body links were unchanged; external links were not revalidated.
- Restore: use the manifest to copy an original backup to its matching `original_path` only after checking for later edits. The Git baseline also retains the original assets.
