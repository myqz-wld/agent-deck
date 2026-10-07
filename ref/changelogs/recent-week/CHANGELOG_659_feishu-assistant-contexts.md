---
changelog_id: 659
changed_at: 2026-09-29
---

# Independent Feishu assistant chat and work sessions

## Summary

The Feishu assistant keeps its own persistent conversation history. Creating or selecting a work
session changes the explicit work target without redirecting ordinary chat or resetting assistant
history. Both use their independently remembered model choices.

## Commands and presentation

- Ordinary private text always addresses the assistant.
- `/new [task]` creates a work session with the saved work choice. `/sessions`, `/select <id>`,
  `/send <text>` and `/history` list, select, message and inspect work sessions.
- `/chat new`, `/chat list`, `/chat select <id>` and `/chat history` start, list, resume and inspect
  assistant conversations. Previous history is retained.
- `/chat pending`, `/chat runtime`, `/chat subscribe` and `/chat unsubscribe` scope corresponding
  controls to the assistant. Work controls retain their existing unprefixed commands.
- `/settings`, `/models` and the connected Core's Desktop settings keep sharing the same saved
  choices. No provider or model is hardcoded; existing conversations retain their native controls.
- Assistant replies are unlabelled plain text. Work replies use cards identifying their session.
  Command results and interactive approvals identify the target they affect. Groups retain their
  existing private-data restrictions and explicit work-session behavior.

## Persistence and activation

Gateway SQLite schema v5 stores assistant identity/generation and subscription purpose, preserving
v4 owner, pairing, work-selection and delivery metadata through a verified migration. Chat contents
remain in authoritative Core history. Public Core creation returns stable provider IDs, preventing
follow-up messages from using a retired startup placeholder.

Managed Feishu activation checkpoints stopped metadata before a runtime change. Activation failure
restores the previous database and runtime; accepted upgrades discard the checkpoint. A later
intentional schema downgrade needs an explicit matching state backup. Existing native permissions,
credential ownership, idempotency and pending-card action contracts are preserved.

## Validation

Integrated typecheck and 6,767 tests pass, with three existing skips. Source app build passes.
Regressions cover stable creation handles, independent routing/history, gateway reopen, assistant
reset/restore, source presentation, strict schema migration and rollback after a real migration.
Linux/runtime packaging and deployment checks pass, including both architecture archives and privacy/ABI
audits. macOS activation and real owner acceptance remain in the active delivery plan.

## Prompt assets and file structure

The shared `src/gateways/im/conversation-prompt.ts` implements the owner's assistant/work separation
and unlabelled assistant replies for all adapters. Claude/Codex conventions were checked without
changes; native tool/permission differences remain authoritative. The local prompt inventory was
refreshed; no standing custom points were added. Context persistence and test fixtures were split;
no changed source exceeds 500 lines and no split exemption is required.

- [Failure diagnosis and validation](../../reviews/recent-month/REVIEW_299_feishu-assistant-contexts.md)
