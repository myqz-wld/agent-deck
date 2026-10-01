---
review_id: 304
reviewed_at: 2026-09-30
baseline_commit: 2714af4be096e6745de07dcbb2604b7e63ce5f7e
expired: false
---

# Feishu input, approval, and reaction progress

Latest owner evidence: the fresh natural creation approval reaches a terminal approved card;
the named work reply and input completion reaction are visible. Core independently confirms
completion and no pending requests. See
[PLAN_74](../../plans/recent-3-days/PLAN_74_feishu-relay-live-acceptance.md). This does not claim
live coverage of every rich-text variant or the remaining expired-card copy improvement.

## Scope and method

Local producer/consumer inspection and fault-injection tests; no additional agents or independent
review claim. The expiry script was attempted and again exited on legacy incomplete coverage.
All changed files below were reviewed without inherited exemptions. Unrelated legacy scope remains
outside this bounded review.

```review-scope
README.md
UI_COPY_LANGUAGE.md
deploy/linux/feishu/README.md
src/gateways/feishu/event-adapter.test.ts
src/gateways/feishu/event-adapter.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/mapper.ts
src/gateways/feishu/message-content.ts
src/gateways/feishu/message-progress-integration.test.ts
src/gateways/feishu/message-reactions.test.ts
src/gateways/feishu/message-reactions.ts
src/gateways/feishu/message-semantics.test.ts
src/gateways/feishu/pending-card-callback.test.ts
src/gateways/feishu/pending-card-content.ts
src/gateways/feishu/rich-message.test.ts
src/gateways/feishu/runtime.ts
src/gateways/feishu/sdk.test.ts
src/gateways/feishu/sdk.ts
src/gateways/im/audit-transport-retirement.test.ts
src/gateways/im/command-executor.ts
src/gateways/im/commands.ts
src/gateways/im/display-labels.test.ts
src/gateways/im/display-labels.ts
src/gateways/im/gateway.ts
src/gateways/im/group-egress.test.ts
src/gateways/im/message-progress.ts
src/gateways/im/notification-delivery.ts
src/gateways/im/pending-action.ts
src/gateways/im/pending-binding.ts
src/gateways/im/pending-revision.test.ts
src/gateways/im/preferences.ts
src/gateways/im/render.ts
src/gateways/im/session-create.ts
src/gateways/im/subscription-events.ts
src/gateways/im/types.ts
src/hosts/server-core/feishu-progress.test.ts
src/hosts/server-core/runtime-core.ts
src/hosts/server-core/session-manager-observer.ts
```

## Findings and fixes

- HIGH: An unchanged native pending request became unapprovable whenever unrelated Core state
  advanced the global revision. Verify current request content against the originally signed
  presentation and nonce, then submit with the fresh Core revision. One explicit CAS conflict
  permits one complete re-read/revalidation with the same idempotency key. Changed parameters,
  regressed revisions, expired signatures and ambiguous outcomes do not bypass approval.
- MEDIUM: Feishu post messages, including pasted quotes and styled text, were rejected before
  Core. Parse the official receive-post projection with bounded rows/nodes/UTF-8 text, preserve
  links/code/paragraphs, and retain authenticated mention, tenant, owner and input-expiry checks.
  Attachments are represented as unread placeholders, without fetching or claiming to read them.
- MEDIUM: Approval UI exposed internal request/version fields and mixed English status text.
  Known Agent Deck operations now use Chinese labels. Hide only known tracking fields for the
  three native management tools; raw parameters still participate in the signed content digest.
  Unknown tools retain their fields. Runtime presentation retains redaction before translation.
- MEDIUM: Message progress needs an actual execution boundary, not enqueue acceptance or assistant
  commentary. Feishu-only sends use existing native deferred user-event correlation. Core metadata
  exposes bounded correlation IDs and completion flags without bodies. The gateway updates the
  original input reaction only after the matching turn starts; approval/failure remain distinct.
- Concurrency hardening: serialize reaction changes per message, bound work to four concurrent
  calls/128 entries, deduplicate retries, isolate cosmetic API failures and retain only own reaction
  IDs. A timed-out add blocks a replacement until its late outcome is cleaned, preventing a delayed
  cleanup from deleting a newer reaction. Graceful shutdown removes unfinished indicators.

## Validation

- Full suite: 6,881 passed and three existing opt-in skips (1,114 passing files, two skipped).
  Two additional Chinese presentation/redaction checks pass separately; typecheck passes afterward.
- Directed SDK/gateway/Core batch: 362 passed, including real callback terminal cards, global
  revision changes, CAS races, changed parameters, rich text ingress, queued turns, early replies,
  credential/chat fencing, API timeouts and cleanup. The reply-delivery hold regression proves
  completion reactions cannot overtake a still-undelivered answer.
- Application build, Linux headless/native runtime builds, architecture, headless and deployment
  checks pass. Shared Electron SQLite binding remains unchanged. No schema migration is needed.
- An initial full run inherited the diagnostic log's restrictive umask, causing 35 fixture-mode
  failures in three unchanged files. Re-running with the normal process umask passes. Logs remain
  in a mode-0700 private directory; no production permission policy was weakened.
- All changed source files are below 500 lines. Public attribution, staged privacy and actual package audits passed.
  [Installed acceptance](../../plans/recent-3-days/PLAN_72_feishu-input-approval-activation.md)
  confirms the exact new release, a single formal application and healthy managed services.

## Residual risk and next acceptance

- Reactions require the official message-reaction write grant. The owner approved that exact grant
  and publication. Browser confirms the single added app-identity grant is enabled and all current
  changes are published. The owner confirms the real assistant reply and processing-to-completion
  reaction test succeeds; native work creation/approval remains pending.
- Reaction metadata is intentionally transient. An abrupt process crash may leave an old indicator
  on Feishu; no success is inferred from elapsed time. This does not alter durable messages,
  approvals or business state.
- The earlier warm-channel stall was recovered by a same-digest managed Feishu restart. Its precise
  cause remains unproven; this change does not claim a source-level fix for that incident.
- User validation of natural creation/naming and the current approval card remains required.

## Primary references

- [Received message content](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content)
- [Reaction creation and permissions](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)
- [Official emoji catalog](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-reactions.md)

## Installed acceptance

Release 3ea213cf is installed at the formal application path. Its ASAR matches the audited package;
Worker/supervisor, Relay and Feishu/Core independently pass. The first attempt failed during a local
Docker Hub pull before remote or Desktop mutation. The owner subsequently opened the temporary
package; recovery installed that same verified package, removed it from build/dist and cleared both
the temporary and hidden-backup Launch Services registrations. One formal GUI and one application
registration remain. No reinstall is required.
