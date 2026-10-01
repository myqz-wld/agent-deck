---
plan_id: 80
completed_at: 2026-10-01
status: completed
---

# Feishu assistant settings and creation flow

## Goal and decisions

- Keep the Feishu settings panel focused on its assistant.
- Owner confirmed that Desktop and Feishu use the same creation interaction, with separate last-used choices.
- New work chooses its adapter during creation when no choice exists, then remembers explicit choices.
- Show resolved defaults instead of extra follow-default options.
- Apply the shared 150 ms grace to complete initial reads, refreshes, and adapter/Gateway transitions.

## Scope and invariants

- Renderer Feishu settings, related command recovery copy, and creation-flow validation.
- The owner separately approved the creation rule and setup version in `src/gateways/im/conversation-prompt.ts`.
- Retain stored choices, current sessions, native approval and Workspace boundaries, revision checks, and stale-response fences.
- Do not unify Desktop/Feishu persistence, alter transport schemas, deploy, restart, or replace running applications.

## Completed work

- Read existing creation paths and presentation hooks; both creation entry points already remember explicit choices.
- Removed the redundant settings editor, fixed combined readiness and retained forms, and updated direct-creation recovery.
- Added timing and selection regressions. Type checks and 260 relevant tests passed; the final presentation adjustment passed 29 settings tests.
- Archived the result in [CHANGELOG_671](../../changelogs/recent-3-days/CHANGELOG_671_feishu-assistant-settings-flow.md).

## Preserved boundaries and validation

- Default display does not persist unedited runtime overrides.
- Refresh retains drafts; source changes discard old Core responses and save completions.
- Unsupported saved options remain visible and unsaveable.
- Verified 149/150 ms, combined preference/capability loading, fast and slow transitions, refreshed defaults, and direct creation without prior settings.

## Final status and handoff

Source implementation and targeted validation are complete. Remote gateway/Core activation remains
a separate deployment action. No installed application or live process was changed.

## Unresolved questions

None.
