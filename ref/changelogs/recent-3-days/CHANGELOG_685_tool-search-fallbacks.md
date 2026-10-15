---
changelog_id: 685
changed_at: 2026-10-15
---

# Apply native Tool Search configuration at the correct boundary

Codex Gateway or custom Agent model catalogs now reach app-server at startup for new, resumed,
and forked sessions. This allows compatible custom model aliases to use native deferred tools
instead of silently ignoring their catalog. Existing clients reject catalog changes with a
new-session instruction; native defaults and owning-host safety boundaries are preserved.

Claude's existing Gateway JSON `env.ENABLE_TOOL_SEARCH` opt-in was verified with and without
sandbox-derived settings. No new UI or automatic Gateway configuration change was added. README
keeps only concise usage guidance; full MCP contracts and provider-native policies are retained.

## Validation

Typecheck, 7,443 tests, and build passed. Local fake inference captured zero initial MCP definitions
after Codex startup catalog delivery and Claude explicit opt-in, then one definition after
discovery. No real token/billing measurement or live application activation was performed.

## Do Not Split Protection

None required: changed production source files remain within 500 lines.

See [the repair audit](../../reviews/recent-3-days/REVIEW_332_tool-search-fallback-repairs.md) and
[the completed plan](../../plans/recent-3-days/PLAN_96_tool-search-fallbacks.md).
