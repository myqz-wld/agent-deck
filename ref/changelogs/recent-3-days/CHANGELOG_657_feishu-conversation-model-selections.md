---
changelog_id: 657
changed_at: 2026-09-29
---

# Feishu conversations and remembered model selections

## Summary

The paired owner can start a normal Agent Deck conversation by sending a private message after
choosing a model. Feishu and the connected Core's Desktop settings share separate remembered
selections for bot conversations and new work sessions. Existing provider sessions supply chat,
coding, terminal execution and management tools without a second execution engine.

## Changes

- Add owner-only `feishu.preferences.get/update` methods with bounded adapter, provider, model
  and thinking fields. Core stores choices atomically in an owner-only file. A settings revision
  detects concurrent edits independently of provider event revisions; mutation claims fence
  replay and uncertain writes. No gateway database migration or credential payload is introduced.
- Add `/settings`, `/models`, `/new` and `/create last`. Explicit `/create` adapter/model options
  become the next remembered work selection. Missing initial selections request a choice;
  unavailable saved choices remain saved and never silently select another adapter.
- Add the Feishu section to Desktop settings with live Core capability choices, profile/authority
  fences, explicit save/refresh and the shared 150 ms loading grace. Local settings never supply
  a fallback configuration for the selected remote Core.
- Bootstrap private conversations with a shared, user-text-independent setup message and stable
  chat-generation mutation identity, then send the original owner message separately. Persist
  the selected session before subscription and sending, serialize same-chat creation/selection,
  and hold notification draining during admission so fast provider replies are retained.
- Automatically subscribe new private conversations and explicitly created private sessions.
  Preserve explicit unsubscribe, native permission defaults, Workspace restrictions and pending
  action fences. Ordinary chat suppresses transport bookkeeping replies.
- Add the read-only `get_feishu_preferences` Core MCP tool. The shared conversation prompt reads
  current work-session preferences before user-requested creation instead of retaining a stale
  startup snapshot. Claude/Codex/Grok conventions remain unchanged.
- Present compact command cards with standalone private results, while retaining group threading
  and native pending-card callbacks. Groups cannot read/change shared model preferences or auto
  create conversations; explicit group creation does not overwrite private remembered choices.
- Advance the exact-match protocol to 2.9 and append method-directory bits without reindexing
  existing entries. Desktop, Worker, Server and Feishu require coordinated activation.

## Validation

- Architecture and Node/renderer typechecks pass.
- The integrated suite passes 6,733 tests, with three existing skips across two files.
- A preceding full run hit one unrelated Issue-panel retry test failure; that file passed in
  isolation and the subsequent integrated full suite passed without changing its implementation.
- Focused tests cover first-choice guidance, separate remembered values, explicit overrides,
  live MCP reads, concurrent saves, lost-create replay, fast provider notifications, unsubscribe,
  group privacy, private persistence, unavailable choices, profile switching and delayed loading.
- Linux headless reproducibility, both pinned Feishu runtime builds, static packaging and
  deployment automation checks pass. The shared Electron SQLite binding is unchanged.
- Actual archives each contain 37 members / 26 files; both archives and all 11 Node bundles pass
  private-identifier checks. A focused durability regression also fences a file replacement that
  succeeds before a directory fsync failure, avoiding an unsafe mutation retry.
- macOS artifact validation and installed end-to-end acceptance are recorded separately after
  packaging/activation. These source checks do not claim real provider or pending-card acceptance.

## Do Not Split Protection

No new source-file exemption. Conversation creation, settings commands, Core persistence/runtime,
Desktop IPC, UI controls and Hook failure copy are separate modules below 500 lines.

## Activation and retained work

The installed Desktop and accepted Relay/Feishu release remain unchanged until an exact coordinated
replacement is approved. Keep the active Feishu acceptance plans until real private replies,
natural-language management and a native pending action have been exercised. Preserve existing
pairing, private deployment configuration and recovery backups.
