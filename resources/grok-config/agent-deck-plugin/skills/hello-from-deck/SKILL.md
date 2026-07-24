---
name: hello-from-deck
description: "Agent Deck built-in Grok skill self-check. Use for /agent-deck:hello-from-deck, deck self-check, or requests to verify that the Agent Deck Grok plugin loaded."
---

# Hello From Deck

1. Reply with `Agent Deck bundled skill is ready: hello-from-deck`.
2. Include the current session cwd and an ISO timestamp, using existing context or Grok's non-mutating shell tools.
3. If either lookup fails, print `cwd unavailable` or `time unavailable` with the reason while keeping the fixed confirmation.

The check passes when all three values are present.
