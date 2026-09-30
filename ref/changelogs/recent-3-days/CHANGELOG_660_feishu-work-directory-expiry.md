---
changelog_id: 660
changed_at: 2026-09-30
---

# Feishu work-session directory and stale message expiry

The assistant can query an explicit work-session directory instead of reporting itself as work.
Incoming Feishu messages more than five minutes old are acknowledged without execution or replies.

## Changes

- Add the Feishu-owner-only `feishu.assistants.register` channel method. It reconciles existing
  canonical assistant identities into a bounded private Core file, without changing sessions,
  pairing, model settings, native permissions or SQLite schemas.
- Add read-only `list_work_sessions` for registered assistants. It includes active and dormant
  work, excludes assistant histories and internal/archived rows before paging, and exposes an
  explicit continuation when the bounded scan has more candidates. Generic collaboration and
  normalized event-history access retain their existing contracts.
- Reconcile purposes before a private assistant input and after conversation creation/selection.
  Reconnects preserve existing histories and notification choices. User text remains unchanged.
- Use the original Feishu message creation time, normalized from supported timestamp units, for
  the five-minute admission boundary. Expired input never reaches pairing or Core; the successful
  callback acknowledgement stops platform retries. Running tasks and reply notifications continue.
- Advance the exact public protocol to 2.10 and append the method bit without shifting old bits.
  Activation requires matching Server, Worker/Desktop and Feishu artifacts, preserving credentials.

## Validation

Twenty-one new regression cases cover identity, pagination, recovery, readonly metadata, native
permission preservation and stale input. The complete suite passed 6,792 tests with three existing
opt-in skips. Architecture/typecheck, application build and final Linux reproducibility passed.
Both pinned Linux runtime archives, headless/deployment gates and artifact privacy checks passed.
Live activation and business acceptance remain pending at this source checkpoint.

## Do Not Split Protection

None. All changed source files remain at or below 500 lines.

See [REVIEW_301](../../reviews/recent-3-days/REVIEW_301_feishu-work-directory-expiry.md).
