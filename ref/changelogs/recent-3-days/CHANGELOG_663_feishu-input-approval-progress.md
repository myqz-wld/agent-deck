---
changelog_id: 663
changed_at: 2026-09-30
---

# Feishu rich text, approvals, and message progress

## Summary

Feishu accepts pasted rich text and quotes, keeps unchanged approval cards usable across unrelated
state updates, and shows processing/approval/completion/failure as reactions on the original input.
User-facing operations, parameter labels and status/error text use Chinese.

## Changes

- Parse bounded receive-post text, links, mentions, paragraphs and code. Preserve the same owner,
  tenant, bot-mention, control-character and five-minute expiry checks as plain input.
- Bind approval to the reviewed request content instead of requiring an unchanged global revision;
  retain signatures, expiry, exact parameters, Core CAS and stable one-time mutation semantics.
- Hide native management tracking fields, translate meaningful labels, and retain unknown tool
  arguments and full security digests. Model names and executable command/JSON syntax stay intact.
- Replace the bot's own input reaction through processing, approval wait, completion and failure.
  Deferred provider acceptance correlates queued Feishu turns; commentary never marks completion.
  Cosmetic failures cannot block business replies. No message bodies or reaction IDs enter SQLite.
- Add the narrow reaction permission requirement to Feishu deployment guidance. Existing paired
  credentials, assistant/work model selections, native controls, prompts and histories are unchanged.

## Validation

Full suite: 6,881 passing tests and three existing skips; two additional Chinese presentation tests
pass separately. Directed batch: 362 passing tests. Typecheck/architecture, application build,
headless/native builds and deployment checks pass. See
[local review](../../reviews/recent-3-days/REVIEW_304_feishu-input-approval-progress.md) for race,
redaction and retry evidence. Actual artifact and live activation checks are recorded separately.

## Do Not Split Protection

None. All changed source files remain below 500 lines.
