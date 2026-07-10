---
changelog_id: 351
changed_at: 2026-07-09
---

# CHANGELOG_351_mcp-prompt-contracts: Make MCP contracts explicit and self-correcting

## Summary

Agent Deck MCP now gives coding agents a concise English spawn contract, current model suggestions, adapter-specific thinking values, and actionable recovery hints. Optional model and thinking overrides remain scoped to the spawned session and never mutate existing sessions or global defaults.

## Changes

### Spawn contract

- Added `fable-5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` to maintained model suggestions while preserving custom provider-model passthrough.
- Documented Codex `minimal` through `ultra` and Claude/Deepseek `low` through `max` without advertising unsupported Claude `ultra`.
- Made required fields, adapter boundaries, override precedence, per-session isolation, provider validation, return anchors, and retry behavior explicit in the MCP schema and tool description.
- Synchronized the spawn contract across bundled Codex and Claude runtime prompts and the README.

### Self-correcting errors

- Preserved underlying provider, adapter, storage, and validation errors while adding bounded retry or exact corrective actions.
- Replaced stale or misleading recovery advice with the next valid Agent Deck tool, exact field shape, allowed value source, UI action, or stop condition.
- Added actionable errors across spawn, messaging, shutdown, task, issue, plan presentation, and diff presentation handlers.
- Converted uncaught message enqueue failures into structured MCP errors without hiding the original exception.

## Validation

- Targeted spawn, messaging, shutdown, task, issue, plan, and diff MCP tests — 7 files and 237 tests passed.
- `pnpm typecheck`
- `pnpm test` — 191 files and 2142 tests passed.
- `pnpm build`
- `git diff --check`
- Prompt-asset inventory, 18-file backup manifest, paired-prompt alignment, and post-edit hash verification.

## Do Not Split Protection

None. The change updates existing tool-contract boundaries and their focused tests; no first-party source file exceeds the repository's 500-line limit.

## Notes

- Suggested models are discoverability metadata, not an allowlist.
- Bare `gpt-5.6` is intentionally omitted so Agent Deck does not collapse the explicit GPT-5.6 tier selection.
- Forked spawn context remains a separate future behavior change; this pass changes prompt and error contracts only.
