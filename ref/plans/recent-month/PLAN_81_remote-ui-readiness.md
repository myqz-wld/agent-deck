---
plan_id: 81
completed_at: 2026-10-01
status: completed
---

# Remote UI readiness and assistant autosave

## Goal and confirmed decisions

- Inspect and improve all remote UI entry points for retained data and the shared 150 ms rule.
- The owner chose direct repairs within the existing structure rather than the complex-planning workflow.
- Remove both Feishu save and refresh buttons. Changes save automatically; model text commits on blur/Enter.
- Make the assistant configuration a single compact form, including runtime controls.
- Suppress repeated loading copy; coordinate settings as one initial presentation.
- Prior commit/push authorization continues for this feature. No deployment or host process action is authorized.

## Invariants

- Keep existing remote capability, identity, Core generation, revision, and mutation-authority checks.
- Retain only bounded in-memory read projections, partitioned by complete source and resource identity.
- Revalidate on reopening; stale read projections never authorize a write. Never reuse another source's state.
- Serialize automatic preference writes, preserve the latest owner edit, and reconcile uncertain/conflicting saves.
- Retain complete content during fast reads; show one meaningful wait state after 150 ms when necessary.
- Do not cache permissions as mutation authority, persist private UI data, change protocol/schema, or restart/install the host.

## Audit matrix

| Surface | Initial evidence | Status |
| --- | --- | --- |
| Settings / Feishu | Parent now joins configuration, Hook and Feishu readiness; cached projections survive reopen; compact autosave form | Implemented; 13 autosave regressions pass |
| Assets / conventions | Bounded catalogs and revision-qualified convention projections retained; disconnect retires old reads | Implemented; reconnect and warm-reopen regressions pass |
| Live / History / Pending | App-owned source and mounted panels already retain data and coalesce refreshes | Existing behavior retained; regression suites pass |
| Issues / issue detail | Mounted list retains data and delays initial presentation; details use revision-fenced reads | Existing behavior retained; regression suites pass |
| Usage | Added delayed progress and retained daily totals/reset controls during refresh | Implemented; targeted regressions pass |
| Session detail / tasks / messages / events / diffs | Added bounded presentation caches; runtime/input authority is read again before actions | Implemented; targeted regressions pass |
| New session / other dialogs | Existing complete projection and 150 ms helpers | Existing behavior retained; regression suites pass |

## Work and validation

1. Complete the inventory and record concrete gaps; keep already-correct flows unchanged.
2. Repair assistant layout/autosave and settings initial coordination.
3. Retain bounded read data across remote revisits and revalidate through existing readers.
4. Add targeted tests for 149/150 ms, revisit reuse, duplicate loading suppression, isolation, and autosave races.
5. Run type checks, applicable tests, and build for the overall change. Validate representative UI using the session Browser with synthetic fixtures.
6. Archive findings and this plan, inspect privacy and commit metadata, then commit/push.

## Final validation and handoff

Implementation and validation are complete. pnpm typecheck, pnpm test and pnpm build pass.
The final full test run passed 6,989 tests across 1,130 files, with six existing test skips in
three files. Focused regression checks and Browser inspection are recorded in REVIEW_311.

The Browser used real assistant components and production CSS with synthetic preferences.
The compact form has no normal save/refresh controls. Selecting a synthetic Gateway updated
model/thinking defaults and recorded one automatic save. The private tab was closed.
No real remote preferences or quota credits were changed.

The quota page retains its explicit refresh button, following the owner's latest correction.
Caches remain bounded, in memory, and separated from mutation authority. No backend schema,
prompt, installation, deployment or running host process changes are part of this delivery.

Final records: CHANGELOG_673_remote-settings-autosave.md and REVIEW_311_remote-ui-readiness.md.
Source delivery uses the existing commit/push authorization on main. Temporary fixtures and raw
validation output are removed after recording the results; no private machine paths are archived.

## Unresolved questions

None. Engineering choices remain bounded by the existing source isolation and presentation rules.
