---
review_id: 299
reviewed_at: 2026-09-29
baseline_commit: 897d466ee5cbc6a8f6cc53a1c432f0c7a246e918
expired: false
---

# Feishu stable session handles and independent assistant context

## Scope and method

Live owner failure diagnosis, normalized Core metadata/history inspection, changed-scope inspection,
regression tests and integrated validation. No independent agents or paired review were requested.
The expiry helper still stops on legacy empty scope input; coverage below was inspected directly.

```review-scope
src/gateways/feishu/message-semantics.test.ts
src/gateways/feishu/sqlite-assistant-migration.test.ts
src/gateways/feishu/sqlite-context-store.ts
src/gateways/feishu/sqlite-delete-confirmation-store.ts
src/gateways/feishu/sqlite-pairing-delete.test.ts
src/gateways/feishu/sqlite-schema-v4.fixture.ts
src/gateways/feishu/sqlite-schema.ts
src/gateways/feishu/sqlite-store.test.ts
src/gateways/feishu/sqlite-store.ts
src/gateways/im/assistant-context.test.ts
src/gateways/im/audit-bounds-binding-runtime.test.ts
src/gateways/im/audit-store-mutation.test.ts
src/gateways/im/chat-context.ts
src/gateways/im/command-executor.ts
src/gateways/im/commands.ts
src/gateways/im/conversation-prompt.ts
src/gateways/im/conversation-router.test.ts
src/gateways/im/conversation-router.ts
src/gateways/im/errors.ts
src/gateways/im/gateway.test.ts
src/gateways/im/gateway.ts
src/gateways/im/notification-delivery.ts
src/gateways/im/notification-message.ts
src/gateways/im/preferences.test.ts
src/gateways/im/preferences.ts
src/gateways/im/render.ts
src/gateways/im/session-create.ts
src/gateways/im/source-presentation.ts
src/gateways/im/store.ts
src/gateways/im/types.ts
src/gateways/im/validated-store.ts
src/hosts/server-control/feishu-control-service.test.ts
src/hosts/server-control/feishu-control-service.ts
src/hosts/server-control/feishu-runtime-retention.test.ts
src/hosts/server-control/feishu-runtime-upgrade.ts
src/hosts/server-control/feishu-state-checkpoint.ts
src/hosts/server-control/systemd.ts
src/hosts/server-core/session-console-authority.test-fixture.ts
src/hosts/server-core/session-console-authority.test.ts
src/hosts/server-core/session-console-authority.ts
```

## Findings and fixes

HIGH: Public Core session creation returned Codex's temporary UUID before the provider renamed it.
The real owner saw a successful creation card, followed by `not_found` on the next message. Core
retained one finished Codex session with a different canonical ID and an assistant history event;
the card's ID had no record. Public creation now waits for the canonical ID, as the trusted spawn
path already did. The mutation ledger commits and replays only that stable handle. Native Desktop
creation retains its existing temporary-ID UI lifecycle.

HIGH: One `activeSessionId` served both the assistant conversation and the selected work session.
Creating/selecting work could redirect ordinary chat and replace the assistant's effective history.
Persist independent assistant ID/generation alongside the work selection. Ordinary private text
uses the assistant; explicit work commands use the selected work session. Stable assistant creation
keys are independent of work-selection timestamps. Reopening the gateway keeps both bindings.
Restarting or resuming assistant chat retires the prior assistant notification binding and preserves
work subscriptions. Group behavior and owner/Workspace boundaries remain enforced.

MEDIUM: Responses did not distinguish assistant chat from work-session output. Per the owner's
explicit preference, ordinary assistant replies remain exact plain text with no source label.
Work responses use a card with the session identifier; pending cards and command results identify
their target. `/chat` commands and work commands have separate lists, history, selection and
notification controls. Pagination preserves the selected command scope.

HIGH: The new metadata migration exposed an existing rollback assumption: reverting only the
runtime pointer cannot start an older binary after the database format changes. The managed upgrade
now stops the verified service, creates a private metadata checkpoint, activates and verifies the
new runtime, and restores both database and pointer on activation failure. Failed database bytes
are preserved privately; successful activation discards the temporary checkpoint. Owner/mode,
regular-file and journal checks prevent unsafe snapshots. Explicit later schema downgrades require
a matching operator-owned state backup; they are not silently inferred from a runtime pointer.

## Validation and evidence

- Live diagnosis used normalized Core APIs and sanitized gateway audit codes. Raw provider
  transcripts, credentials, owner identifiers and message bodies were not copied into records.
- Canonical-ID regression checks delayed provider initialization, commit identity and cached replay.
- Context regressions check plain text versus explicit send, work creation/selection, restart,
  assistant reset/restore, separate lists/history and plain assistant versus identified work output.
- SQLite migration tests preserve old work bindings, credentials and cursors across v4-to-v5/reopen,
  retire only prior assistant notifications and reject modified source schemas before mutation.
- Upgrade tests perform an actual SQLite migration, fail activation, then verify original bytes,
  prior runtime health, mode-0600 state and a private preserved failed v5 database.
- Source suite: 6,743 passed, three existing skips. Integrated latest main: 6,767 passed, three skips.
  Architecture/typecheck, app build, Linux reproducibility, headless/package and deployment gates pass.
  Both pinned Feishu runtime archives pass content/privacy/ABI audits; macOS activation follows separately.
- Shared Electron SQLite ABI remains unchanged. Changed source files are at or below 500 lines;
  context persistence and authority-test fixtures were extracted instead of adding exemptions.

## Residual risk and follow-up

Source fixes are committed; the active installation still needs this new release. Transport health
and a stored assistant event do not establish end-to-end bot acceptance. Complete a real assistant
reply/history test, a work-session reply using its separate saved choice, natural-language management
and a pending-card action after coordinated activation. The existing Feishu plan remains active.
The broader Browser, Grok and storage issues remain resolved.
