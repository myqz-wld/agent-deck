---
plan_id: 88
completed_at: 2026-10-14
status: completed
---

# Unified permission modes

## Goal and authorization

Unify Claude, Codex, and Grok session controls around automatic approval and no routine approval
prompts. Remove work-mode/planning choices. The user approved direct implementation without the
full staged planning workflow, and allowed an edit-only third choice only if all three providers
support it. Codex has no equivalent `acceptEdits` preset, so the final interface has two choices.

## Decisions and invariants

- Map the common selection onto each provider's native controls; keep mandatory provider rules,
  classifier availability, and sandbox configuration authoritative.
- Use Claude `auto` / `bypassPermissions`, Codex `on-request` plus `auto_review` / `never`, and
  Grok's native auto / always-approve flags. Do not add a host-side blanket approval response.
- Reuse the existing permission column. Preserve legacy provider state until explicit selection;
  never infer broader Codex access from contradictory legacy Claude permission metadata.
- Cover creation, resume/fallback, live changes, handoff, Local/Core UI, CLI/MCP, and Feishu defaults.
- The user's Grok read-only question does not request a sandbox change. The built-in profile keeps
  project files read-only but permits state and temporary writes.
- Preserve concurrent changes. Do not stop or replace the installed application or live providers.

## Completed work

1. Verified native Codex schema and Grok metadata/permission-notification contracts.
2. Added shared presets and adapter-specific creation, recovery, fork, and live-control plumbing.
3. Implemented serialized switching, rollback, stale-metadata protection, and legacy mutation guards.
4. Unified desktop/remote/handoff/preferences controls and adjusted capabilities and public contracts.
5. Updated README and the three relevant MCP description/schema assets. Checked Claude/Codex/Grok
   instruction counterparts, local links, and the retained local prompt inventory.
6. Added behavioral regression tests, extracted handoff fixtures, and documented the two remaining
   file-size exceptions in the changelog.

## Validation

A source snapshot containing only this delivery's 117 changed files over baseline
`aeb0a90f99e8ceba9e3dacad5f0bca7e644137ee` passed `pnpm typecheck`, `pnpm build`, and full `pnpm test`
(7,188 passed, 6 skipped). Snapshot hashes still match the working files. The final focused workspace
run passed 73 tests. The shared checkout also contains a separate in-progress Relay diagnostic test
with a failure and type error; those files were preserved and excluded from the snapshot.
Privacy, local links, prompt hashes, whitespace, and archive bucket routing checks passed.

## Final status and handoff

Implementation is complete. No active implementation decisions remain. The currently installed
application has not loaded this source change; updating the package and restarting the exact live
instance are separate actions that require user authorization under the host-runtime safety rule.
The user subsequently authorized committing this delivery and an IAB interaction demonstration.
No application replacement, restart, or publication was requested.

Final record: `ref/changelogs/recent-3-days/CHANGELOG_677_unified-permission-modes.md`.
