---
review_id: 302
reviewed_at: 2026-09-30
baseline_commit: 05d16d2da53f1a203569ea912a8d801ae2ecd04a
expired: false
---

# Feishu native settings and approval completion

## Scope and method

Local producer/consumer review, normalized live Core history, metadata-only remote probes and
same-session Browser inspection of official Feishu documentation. No independent or paired-review
claim: the owner prohibited additional agents. Review expiry was checked; the bounded changed
scope below was re-read, including affected legacy fixtures. Unrelated legacy coverage is not claimed.

```review-scope
deploy/linux/feishu/README.md
src/contracts/feishu-preferences.test.ts
src/contracts/feishu-preferences.ts
src/gateways/feishu/card-renderer.ts
src/gateways/feishu/event-adapter.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/pending-card-callback.test.ts
src/gateways/feishu/pending-card-content.ts
src/gateways/feishu/source-registry.ts
src/gateways/feishu/transport.ts
src/gateways/im/approval-routing.test.ts
src/gateways/im/audit-bounds-binding-runtime.test.ts
src/gateways/im/audit-resync-shutdown.test.ts
src/gateways/im/audit-stream-generation.test.ts
src/gateways/im/audit-subscription-lifecycle.test.ts
src/gateways/im/audit-validation.test.ts
src/gateways/im/command-executor.ts
src/gateways/im/commands.ts
src/gateways/im/conversation-prompt.ts
src/gateways/im/conversation-router.ts
src/gateways/im/delivery-hardening.test.ts
src/gateways/im/gateway.ts
src/gateways/im/group-egress.test.ts
src/gateways/im/notification-delivery.ts
src/gateways/im/notification-exhaustion.test.ts
src/gateways/im/pending-action.ts
src/gateways/im/preference-commands.ts
src/gateways/im/preferences.test.ts
src/gateways/im/preferences.ts
src/gateways/im/render.ts
src/gateways/im/security-and-delivery.test.ts
src/gateways/im/session-create.ts
src/gateways/im/source-presentation.ts
src/gateways/im/types.ts
src/hosts/daemon/connection.test.ts
src/hosts/server-core/feishu-preferences-runtime.test.ts
src/hosts/server-core/feishu-preferences-runtime.ts
src/hosts/server-core/mcp-feishu-preferences.test.ts
src/hosts/server-core/mcp-feishu-preferences.ts
src/main/remote-host/service-feishu-preferences.test.ts
src/protocol/version.test.ts
src/protocol/version.ts
src/renderer/components/settings/FeishuPreferencesSection.test.tsx
src/renderer/components/settings/FeishuPreferencesSection.tsx
src/renderer/components/settings/FeishuRuntimePreferenceFields.tsx
```

## Findings and source fixes

- HIGH: After an approval, `pending.responded` queried every subscribed session. A real stale work
  subscription returned `not_found`, fencing notifications before the assistant's completion reply.
  Production Core pending events identify their owning session. Scope reads to that identity and
  keep later replies flowing. Correct old fixtures that incorrectly placed request IDs in entityId.
  A cleared approval does not emit a new empty "waiting for confirmation" notification.
- MEDIUM: The owner saw the original card regain its buttons. Transport PATCHed before returning
  the click callback. This matches the official documented revert condition. Return the completed
  schema 2.0 card in the callback response through the ephemeral source registry; make no pre-response
  PATCH. Repeat clicks refresh an ended card without another provider decision.
- MEDIUM: Approval cards displayed the protocol envelope as JSON. Show the operation and canonical
  parameters with a compact button row, Chinese state text and the affected assistant/work source.
  Keep unknown tool inputs visible. Incomplete or clipped previews offer no approval button.
- MEDIUM: Current assistant runtime edits were absent from the slash parser, and saved selections
  omitted mode/sandbox. Add explicit assistant/work routing, adapter-owned saved fields and live
  capability checks. Same-adapter partial settings preserve the saved model. Existing sessions and
  future defaults remain distinct; changing one does not silently mutate the other.
- MEDIUM: Native sandbox replacement could leave Feishu pointing at an obsolete session ID.
  Rebind only the affected assistant/work target, preserve explicit unsubscribe, and retain the
  assistant generation and purpose metadata. A subscription recovery failure after replacement
  reports the recovery command without replaying the committed runtime mutation.

## Live evidence

The owner received a real Codex MCP permission card for a harmless personal test task and approved
it. Core normalized history records successful `task_create`, a matching completion response and
an empty pending queue. The conditional authorization is satisfied: the existing assistant now uses
on-request with its prior model and Workspace sandbox unchanged; existing work remains never.
Subsequent owner screenshots on the installed 410a release also confirm the readable terminal card,
no restored buttons, successful task completion, /send work output and preserved assistant recall.
No task/chat body, credential, pairing code, app identifier or private host path is retained here.

## Validation

- 6,815 tests passed; three existing opt-in skips. Added 23 meaningful regressions across contract,
  persistence, current/default targeting, capabilities, callback completion and notification routing.
- 337 focused checks passed; the notification adjustment passed 306 gateway checks, and 12 routing
  checks cover target replacement, explicit unsubscribe and recovery without duplicate mutation.
- Architecture/typecheck, application build and final Linux reproducibility passed.
- Both pinned native runtime archives, headless static/package checks and deployment checks passed.
  Each archive has 37 members / 26 regular files. Eleven bundles and both archives passed private
  value/path scans with zero findings. The shared Electron SQLite binding stayed unchanged.
- Public protocol 2.11 rejects older wire contracts before calls. Existing private preference files
  remain readable; no SQLite migration or credential enrollment is introduced.
- Official Browser documentation verified callback sequencing, raw schema 2.0 response cards and
  the native column/button layout. The temporary documentation tab was closed; the owner's existing
  event-log tab remains. The owner later accepted the installed card appearance and terminal state.
- All changed source files are within the 500-line guardrail. No exemption is requested.

## Prompt asset checks

User Custom Points: none. The owner approved the existing preference tool schema/description and
conversation prompt, then explicitly included each adapter's sandbox and mode. Only those prompt
sections changed. The existing work-directory description and paired Claude/Codex conventions were
checked without changes. Local inventory dates/hashes were refreshed; no new standing rule was added.
Native approval, adapter ownership, Workspace limits and unavailable-choice behavior remain aligned.
The separate proposal for new natural-language mutation tools is not implemented by this record.

## Residual risk and next action

The coordinated `410a6db9` Desktop/Worker/Relay/Feishu release is installed and independently
verified. Feishu/Core negotiate protocol 2.11; both connections are healthy. The authorized
assistant on-request default is persisted at preference revision 3 with both selected models,
the work default and existing runtimes unchanged. The final text-only button refinement passed
34 card/transport checks. See [installation acceptance](../../plans/recent-week/PLAN_70_feishu-native-controls-activation.md).
The real terminal card and /send reply passed owner acceptance. A delayed redundant receipt is
handled by the next combined naming/receipt change. Cloud
storage was recovered under the existing artifact-cleanup authorization: three exact retired Relay
image identities were removed without force, pruning commands, service actions or data/config edits.
All managed record checksums, live-container images and current/previous generation images were
checked before removal. Root free space increased from about 340 MiB to 1,210 MiB; both protected
images and manager records remained intact. The exact release budget passed before this upgrade.
The overall Feishu acceptance plans and the now-approved separate natural-management implementation remain active.

Official sources: [callback update sequencing](https://open.feishu.cn/document/common-capabilities/message-card/message-card#915623ac),
[callback response contract](https://open.feishu.cn/document/feishu-cards/card-callback-communication),
[column layout](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/column-set).
