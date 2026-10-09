---
changelog_id: 662
changed_at: 2026-09-30
---

# Named Feishu work sessions and assistant management

## Summary

Feishu work cards use readable Core names, and the assistant can create or rename owner-requested
work while preserving its separate conversation. The requested light catgirl voice applies only
to assistant chat. Subscribed private sends no longer append a redundant late receipt.

## Changes

- Add `/rename <name>` for selected work and `/chat rename <name>` for assistant history. Names
  are shared Core data; cards show the name first and the stable ID in a secondary footer.
- Add registered-assistant `create_work_session`, `rename_work_session` and
  `update_feishu_preferences` MCP tools under native approval. Natural work creation derives a
  task-based name, preserves explicit names and reuses the independently saved work configuration.
  Explicit model/mode/sandbox overrides are remembered without changing an existing runtime.
- Register provisional work before provider output, follow temporary-to-canonical identity changes,
  and select only committed work. Newer user selection and names win. Shared spawn limits, revision
  fences, stable retries and uncertain-startup recovery prevent duplicate or misdirected work.
- Add owner-only `session.name.update`; protocol 2.12 requires matching Desktop, Worker, Server and
  Feishu. SQLite v6 adds identity-only work-registration and assistant-setup metadata. Verified
  v4/v5 upgrades preserve credentials, pairing, histories and existing work selection.
- Update retained assistant history once on its next message or selection; provider replacement
  refreshes that setup for the new identity. Work tasks keep their own prompts and native controls.
- Suppress redundant subscribed private `/send` receipts. Unsubscribed sends retain recovery hints,
  group acknowledgement remains factual, and failed title lookups cannot suppress actual output.

## Validation

- 6,857 tests passed; three existing opt-in skips. The full run includes native tool calls, creation
  failure/rollback, canonical identity, early replies, concurrent selections/names, exact schema
  migrations, v4/v5 managed rollback, persona refresh, approval routing and lost receipt acceptance.
- Typecheck/architecture, application build, Linux headless/native archive construction and
  headless/deployment checks passed. The exact b48d42f1 package is installed and independently
  verified; [installation acceptance](../../plans/recent-week/PLAN_71_feishu-named-work-activation.md)
  records commit/ASAR, one GUI, live service health and retained configuration/history.
- Both native archives (37 members / 26 regular files each) and all 11 headless bundles pass
  private-identifier scans with zero findings; the shared Electron SQLite binding is unchanged.
- All changed source files are at most 494 lines. No split exemption is required.
- Root README remains concise and English. Detailed behavior is maintained in
  [Feishu deployment](../../../deploy/linux/feishu/README.md).

## Do Not Split Protection

None.

## Notes

The approved prompt scope is exactly the two Feishu MCP modules and `conversation-prompt.ts`.
Paired bundled adapter conventions remain unchanged. Assistant/work models, native approval and
Workspace boundaries remain owned by their existing settings. The broader live acceptance plan
stays active until the owner verifies natural creation, readable names and the requested voice.

[Local review](../../reviews/recent-month/REVIEW_303_feishu-named-work-management.md).
