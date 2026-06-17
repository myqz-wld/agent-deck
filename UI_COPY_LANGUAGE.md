# UI/CLI Copy Language

This file is the source of truth for user-facing UI and CLI copy language. Update this file before changing the active copy language mode, default locale, or supported locales.

## Mode

- `single-language`: Simplified Chinese (zh-CN) by default.

## Scope

This file applies to text shown or spoken to users: renderer text, dialogs, settings labels, notifications, CLI wrapper messages, user-facing errors, help text, navigation, buttons, headings, form help, empty states, confirmations, progress text, and accessibility labels.

This file does not govern code identifiers, protocol names, internal logs, debug output, protocol payloads, developer-only comments, test names, or third-party strings unless those strings are rendered to users.

## Rules

- Write new UI/CLI copy in natural Simplified Chinese unless this file is updated first.
- Keep established product, adapter, and technical terms in English or as written in code: Agent Deck, Claude, Codex, Deepseek, MCP, SDK, provider, adapter, session, prompt, token, worktree, model names, tool names, command names, config keys, file paths, event names, and enum/status values.
- When adding a new user-facing surface, write the surrounding sentence in natural Simplified Chinese and leave the technical identifier unchanged.
- If a user requests UI/CLI copy in a different language or locale, update this file first and then make the copy change.
- If project code and this file disagree, stop and update this file or ask for the intended language mode before changing UI/CLI copy.
