---
review_id: 303
reviewed_at: 2026-09-30
baseline_commit: 410a6db9d37c4767c0d51014b3b4f951a5a7607f
expired: false
---

# Feishu named work and receipt ordering

## Scope and method

Local producer/consumer review and fault-injection tests; no additional agents or independent
review claim. The expiry script was attempted and exited early on a legacy empty scope row.
Manual classification from all review baselines was used instead; all changed source was rechecked
without inherited coverage exemptions. Unrelated legacy files are outside this bounded review.

```review-scope
deploy/linux/feishu/README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/contracts/feishu-work.ts
src/contracts/grant-policy.ts
src/contracts/index.ts
src/contracts/methods.ts
src/contracts/session-name.ts
src/gateways/feishu/card-renderer.ts
src/gateways/feishu/sqlite-assistant-migration.test.ts
src/gateways/feishu/sqlite-context-store.ts
src/gateways/feishu/sqlite-schema.ts
src/gateways/feishu/sqlite-store.ts
src/gateways/im/__tests__/fixture.ts
src/gateways/im/approval-routing.test.ts
src/gateways/im/assistant-context.test.ts
src/gateways/im/assistant-setup.test.ts
src/gateways/im/assistant-setup.ts
src/gateways/im/audit-exhaustion-approval.test.ts
src/gateways/im/audit-fencing.test.ts
src/gateways/im/command-executor.ts
src/gateways/im/commands.ts
src/gateways/im/conversation-prompt.ts
src/gateways/im/conversation-router.ts
src/gateways/im/gateway.test.ts
src/gateways/im/gateway.ts
src/gateways/im/notification-delivery.ts
src/gateways/im/notification-message.ts
src/gateways/im/security-and-delivery.test.ts
src/gateways/im/send-receipt-order.test.ts
src/gateways/im/session-names.test.ts
src/gateways/im/session-names.ts
src/gateways/im/source-presentation.ts
src/gateways/im/store-keys.ts
src/gateways/im/store.ts
src/gateways/im/subscription-events.ts
src/gateways/im/types.ts
src/gateways/im/validated-store.ts
src/gateways/im/work-registration.test.ts
src/gateways/im/work-registration.ts
src/hosts/daemon/connection.test.ts
src/hosts/server-control/feishu-control-service.test.ts
src/hosts/server-core/feishu-assistant-authority.ts
src/hosts/server-core/feishu-composition.ts
src/hosts/server-core/feishu-preference-service.ts
src/hosts/server-core/feishu-preferences-runtime.ts
src/hosts/server-core/feishu-work-management.fixture.ts
src/hosts/server-core/feishu-work-management.test.ts
src/hosts/server-core/feishu-work-management.ts
src/hosts/server-core/mcp-feishu-management.test.ts
src/hosts/server-core/mcp-feishu-preferences.ts
src/hosts/server-core/mcp-feishu-work-sessions.ts
src/hosts/server-core/mcp-session-spawn.ts
src/hosts/server-core/mcp-tool-host-production.ts
src/hosts/server-core/mcp-tool-host.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/runtime-mcp-host.ts
src/hosts/server-core/runtime-metadata-store.test.ts
src/hosts/server-core/runtime-metadata-store.ts
src/hosts/server-core/session-manager-observer.test.ts
src/hosts/server-core/session-manager-observer.ts
src/hosts/server-core/session-name-runtime.ts
src/hosts/server-core/session-name-service.test.ts
src/hosts/server-core/session-name-service.ts
src/main/remote-host/product-method-directory.ts
src/protocol/version.test.ts
src/protocol/version.ts
```

## Findings and fixes

- MEDIUM: After a lost Core send response, the retried callback could append an obsolete processing
  receipt after the real work reply. Subscribed private sends now acknowledge silently; deliberate
  unsubscribe and errors remain visible. A lost-acceptance regression proves no duplicate mutation.
- MEDIUM: Work identity was presented primarily as an opaque ID. Persist readable names in Core,
  validate single-line bounded input, compare the prior title, and replay completed renames without
  overwriting a later manual name. Header lookup is cosmetic, bounded and excluded from exhausted
  notification read budgets; IDs remain available in a secondary footer.
- HIGH prevented in the new creation path: Provider output can precede the create result, and Codex
  changes a provisional ID before returning. Persist identity-only provisional subscriptions before
  output, move them atomically, and publish selection only with an atomic committed mutation result.
  Later owner selection wins; failed startup removes only the target's provisional data. Unproved
  rollback keeps the ledger claim and cannot silently create a duplicate.
- HIGH prevented in native management: A live generic session or retired handoff source must not
  mutate owner work. Require a live registered assistant, enforce target visibility and the current
  handoff owner, share spawn limits, validate native capabilities, and fence settings revisions.
  Omitted work controls follow work defaults, never the assistant's current policy.
- MEDIUM prevented during persona activation: Recreating a conversation would lose its history;
  copying setup-version metadata across a fresh provider identity would omit its new rules.
  Send one idempotent versioned update to retained history, and reinitialize provider replacements
  on the next assistant turn while preserving explicit unsubscribe.
- Validation found and repaired the Desktop method directory's missing name endpoint and the old
  schema-version assertion in managed rollback tests. Both Relay and Full now exercise v4/v5 rollback.

## Validation and evidence

- 6,857 full-suite checks pass, three existing opt-in skips; 1,109 files pass and two files skip.
- 373 initial focused checks pass; final additions verify late manual rename preservation, metadata
  commit rollback, cosmetic title failure, provider replacement setup and both old schema versions.
- Typecheck/architecture, app build, Linux native/headless build and deployment checks pass.
- SQLite migration tests preserve pairings, assistant/work selection, cursors, setup version and
  provisional creation state across reopen. An occupied canonical subscription key fails atomically.
- Native MCP tests exercise all three caller adapters, real Core mutation service wiring and exact
  output contracts. Shared native approvals, models, sandbox and Workspace restrictions are retained.
- Both native archives (37 members / 26 regular files each) and all 11 headless bundles pass
  private-identifier scans with zero findings; the shared Electron SQLite binding is unchanged.
- Every changed source file is within the 500-line guardrail. No oversized-source exception is used.

## Prompt asset checks

User Custom Points: none. The owner approved the exact three-file naming/natural-management scope
with “按此范围继续（推荐）”, then explicitly requested the catgirl persona. Only
`mcp-feishu-work-sessions.ts`, `mcp-feishu-preferences.ts` and `conversation-prompt.ts` change prompt
or tool-description semantics. The first adds named creation/rename and retry/ownership contracts;
the second adds explicit saved-choice writes; the third applies task-based names and the requested
assistant-only voice without changing provider permissions. Existing slash work initialization stays
neutral. Paired Claude/Codex instruction assets were checked and kept unchanged. Local inventory
hashes and seven-day freshness were refreshed. No standing rule or unrelated reusable pitfall was
added; no skill metadata/catalog was edited and no gate was skipped. Changed prompt modules have no
new external-link dependency. Runtime schemas and native SDK serialization are tested.

## Residual risk and follow-up

The new batch is source-validated; exact package audit and coordinated installation acceptance are
separate evidence. Protocol 2.12 and SQLite v6 must activate together through the managed lifecycle,
which checkpoints/restores the private database on failure. Keep the accepted current installer
and one rollback package, and preserve all pairing/configuration data. Never reinstall a completed
release as a diagnostic guess. Owner Feishu acceptance must still confirm natural work creation,
readable card names and catgirl voice with existing history. Slash `/new` retains its ordinary
Core initial name; `/rename` or natural-language named creation provides a chosen title.

The prior 410a screenshot already proves /send provider output, assistant recall and persistent
terminal approval styling. Do not recreate the already completed approval test task.
