---
changelog_id: 673
changed_at: 2026-10-01
---

# Automatic assistant settings and retained Remote views

## Summary

Feishu assistant choices save immediately from one compact form. Remote settings, assets and
session detail views retain previously read content and revalidate it; loading feedback observes
the shared 150 ms grace. The quota page keeps its explicit refresh button.

## Changes

- Remove the normal assistant save and refresh buttons. Commit model text on blur or Enter;
  apply select changes after resolving adapter/Gateway capabilities. Opening the form performs
  no write. Unset options start from remote session-creation defaults.
- Group approval/mode and sandbox with assistant, Gateway, model and thinking. Remove the extra
  footer, empty status spacing and duplicated loading messages.
- Serialize and coalesce preference writes against confirmed revisions. Retain the latest draft,
  finish already-requested saves across close/reopen, and reconcile before an explicit error retry.
- Join settings, remote configuration, Hook status and assistant readiness for one initial gate.
  Cache complete remote settings while rereading them, fencing local edits from older reads.
- Retain bounded, expiring projections for assets/conventions, selected session presentation,
  events, tasks, messages, diff pages and immutable diff payloads. Partition by source/resource;
  revalidate mutable data and reread runtime/input authority before enabling session actions.
- Delay quota/token loading copy, keep known totals through refresh, and retain the disabled reset
  control while allowance reads are pending. Preserve explicit quota refresh in Local and Remote.

## Validation

Final tests passed: 1,130 files, 6,989 tests, with three files/six tests already skipped by the
suite. Type/architecture checks and production build passed. Focused checks cover 149/150 ms,
a single initial settings fallback, warm reopen, Core isolation, retired replies, autosave queues
and recovery, Gateway memory and quota controls. Browser inspection used production CSS and
real assistant components with synthetic preferences; Gateway selection updated model/thinking
defaults and produced one automatic save.

See [REVIEW_311](../../reviews/recent-3-days/REVIEW_311_remote-ui-readiness.md).

## Do Not Split Protection

None. All changed source/test files are at most 500 lines. Settings reads and cache policy were
extracted into small modules; AssetsLibraryDialog is exactly 500 lines.

## Notes

No schema, transport, prompt or provider-default change. Caches remain in memory and hold display
projections, not mutation authority. Browser checks did not contact a real remote configuration
or consume reset credits. No installed app, remote service or running host process was changed.
