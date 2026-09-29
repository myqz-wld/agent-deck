---
review_id: 293
reviewed_at: 2026-09-29
baseline_commit: eb8d7d698df31541d66d521f47b6dacb8dba36fc
expired: false
---

# Running Relay recovery

## Scope and method

Live diagnosis of the authorized server update, complete changed-file inspection, and lifecycle
regression tests. No independent agents or Desktop restart were used.

```review-scope
src/hosts/instance-manager/lifecycle.ts
src/hosts/instance-manager/lifecycle.test.ts
src/hosts/instance-manager/recovery.ts
src/hosts/instance-manager/recovery.test.ts
```

## Findings

- MEDIUM: Recovery of a healthy running target replayed the startup preflight. That preflight
  correctly rejects an existing control socket, so the manager could not commit its interrupted
  upgrade journal even after Relay health and credential authority had recovered. Idempotent start
  repeated the same incompatible probe after journal recovery.

## Fixes landed

- Healthy-target recovery checks trusted templates, rendered artifacts, exact installed hashes,
  generation-bound acceptance evidence, unit identity and matching healthy container. It then
  commits the journal target without invoking the startup-only singleton probe.
- Starting an already-active instance validates its existing artifacts and live health and returns
  without reloading, starting or stopping the unit. Missing Relay runtime directories still fail.
  Inactive instances retain the existing startup preflight and cleanup behavior.

## Validation and evidence

- Regression tests reject startup socket probes for an active Relay and assert no start, stop or
  reload. Interrupted-target recovery commits the intended generation and removes its journal.
- Focused lifecycle, recovery and runtime-directory suites: 31 passing tests.
- Final full suite: 6,623 passing tests, three existing skips. An earlier run timed out in an
  unrelated renderer test; that suite passed in isolation and the complete rerun passed.
- Typecheck, Linux headless build/reproducibility, packaging checks and all lifecycle static gates
  passed. Generated artifacts and committed source passed privacy inspection; source files remain
  below 500 lines. Known synthetic home examples are not machine identifiers.
- Review-expiry tooling remains limited by legacy records; complete changed scope was inspected
  directly. No previous review was treated as a permanent exemption.

## Residual risk and follow-ups

Live activation remains in the active Feishu acceptance plan. At this checkpoint, Relay is running,
credential authority has no orphan rows, and the previous managed upgrade journal is still pending.
Socket reachability alone does not establish Feishu message or provider-response acceptance.
