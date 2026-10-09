---
changelog_id: 665
changed_at: 2026-09-30
---

# Independent work and stable Remote reads

## Summary

Remote detail reads wait for temporary Worker SSH write backpressure instead of disconnecting the
shared attachment. Work requested through the Feishu assistant is presented as an independent
session with its saved model and native controls.

## Changes

- Queue Worker output in order within explicit byte/frame and progress bounds; discard queued
  frames when the owned transport closes.
- Keep verified creation provenance separate from parent/child presentation and preserve shared
  creation limits, early reply routing, canonical IDs, manual names and idempotency.
- Reconcile previously committed Feishu work from its exact retained creation record. Preserve
  real delegated children and atomically rebase their depths; leave unrelated hierarchies intact.
- Retain work creation results for provenance. Other completed mutations retain their existing
  expiry policy. No database schema or protocol version changes.

## Validation

The merged release passes 6,913 tests with six skips (three original and three opt-in native
Gateway cases from the separately completed main change). Type/architecture, application build, headless and
deployment checks pass. Read-only live reproduction and regression details are recorded in
[REVIEW_307](../../reviews/recent-month/REVIEW_307_remote-worker-backpressure.md).
Installed Desktop/Worker acceptance is recorded in
[PLAN_76](../../plans/recent-week/PLAN_76_remote-worker-activation.md): concurrent reads remain
connected and existing owner work is independent. Model choices and pairing remain intact.

## Do Not Split Protection

None. All touched source/test files remain below 500 lines.
