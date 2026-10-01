---
review_id: 308
reviewed_at: 2026-09-30
baseline_commit: 22bb5c5c9458ddd7d295ce0509da0aadfb531fcc
expired: false
---

# Feishu expired approval guidance

## Scope and method

Bounded local source review and real callback-path regressions. Review expiry was scanned;
unrelated historical coverage is outside this repair. No additional agents or independent review
claim. The owner explicitly deferred investigation of the older recovered no-reply incident.

```review-scope
src/gateways/feishu/event-adapter.ts
src/gateways/feishu/event-adapter.test.ts
src/gateways/feishu/expired-card.test.ts
src/gateways/feishu/mapper.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/nonce.ts
src/gateways/feishu/pending-card-callback.test.ts
src/gateways/im/display-labels.ts
src/gateways/im/display-labels.test.ts
src/gateways/im/errors.ts
src/gateways/im/pending-action.ts
```

## Finding and repair

**MEDIUM — presentation expiry was reduced to an unrecognized-operation toast.** The mapper
used invalid_nonce for an elapsed card lifetime, then the SDK adapter replaced that classified
failure with its fixed generic rejection. The owner could not distinguish an old card from a
malformed callback and received no useful recovery guidance.

The mapper now validates the complete action/form shape before classifying presentation expiry.
Its dedicated card_expired result survives the adapter and explains how to retrieve current
pending items or start a fresh request when the original has ended. Invalid nonce verification
retains a separate validation-failed message. Both remain rejections: an elapsed presentation
does not call Core, replay work, create an approval or patch an unauthenticated card.

For a still-valid signed callback, an authoritative expired/cancelled Core state produces a
matching terminal card with no action buttons and explicit fresh-request guidance. Missing or
otherwise completed requests retain the existing generic terminal state; no approval is inferred.
HMAC contents, identity binding, request ownership, deadlines and idempotency are unchanged.

## Validation and evidence

- Five new regressions cover elapsed presentation, malformed old action, invalid signature, and
  Core-confirmed expired/cancelled requests. Each checks that pending.respond is not invoked.
- All 51 targeted callback/presentation tests pass, including existing approval terminal-card
  delivery and repeat-click behavior. Full suite: 6,918 passing, six existing skips.
- Typecheck/architecture, reproducible headless build, both native runtime builds and subsequent
  headless/deployment checks pass. The first headless check ran before the native archives existed;
  it passed after its build prerequisite completed, without source or check relaxation.
- Both runtime archives contain 26 regular members with verified checksums and the exact built
  Feishu bundle. Generated headless files and archives contain no private home/worktree paths or
  credential payloads. The shared Electron SQLite binding is unchanged.
- The owner accepted manual rename and the subsequent named work reply with the same session ID.
  Native assistant fixture preparation was independently inspected read-only. Specified-directory
  creation and disposable file/folder deletion remain in live acceptance.

## Residual risk and activation

This source record does not claim runtime activation or the remaining live checks. The official
Server release publishes the desired Feishu runtime; a separate managed Feishu upgrade selects it.
Desktop/Worker need no new package for this presentation-only repair. No database, protocol,
prompt, model, sandbox or approval-policy change is required. All changed source files are below
500 lines. The older no-reply incident remains deferred by the owner and is not claimed fixed.

Related behavior record: [CHANGELOG_666](../../changelogs/recent-3-days/CHANGELOG_666_feishu-expired-approvals.md).
