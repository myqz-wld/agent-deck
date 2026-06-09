---
name: hello-from-deck
description: "Agent Deck built-in skill self-check. Use when the user calls /agent-deck:hello-from-deck or asks whether Agent Deck, the deck plugin, or the Agent Deck skill chain is loaded, including Chinese prompts such as deck 自检. Replies with a fixed readiness message, cwd, and timestamp."
---

# Hello From Deck

Use this skill to verify that the Agent Deck app packaged and injected the bundled skill for the current adapter.

## When To Use

- The user explicitly calls `/agent-deck:hello-from-deck`.
- The user asks whether Agent Deck is loaded, asks for a deck self-check, or asks whether the agent-deck plugin loaded. Treat Chinese prompts such as "agent deck 在吗" / "deck 自检" / "确认一下 agent-deck plugin 加载了吗" as the same trigger.

## Steps

1. Reply with this fixed confirmation: `Agent Deck bundled skill is ready: hello-from-deck`.
2. Include the current session cwd and an ISO timestamp. Use Bash `pwd` + `date` on Claude, shell `pwd` + `date` on Codex, or reuse exact cwd/time values already present in context.

## Pass Criteria

The output includes the fixed confirmation, current cwd, and ISO timestamp.

## Fallback

If `pwd` or `date` fails, output `cwd unavailable` or `time unavailable` and include the tool failure reason. Still output the fixed confirmation so the user can tell that the plugin body loaded.
