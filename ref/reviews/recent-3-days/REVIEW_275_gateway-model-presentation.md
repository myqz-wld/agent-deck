---
review_id: 275
reviewed_at: 2026-09-19
baseline_commit: 642df256bb53fd8b029886238ce1e0de29341290
expired: false
---

# REVIEW_275_gateway-model-presentation: Preserve models across Gateway changes

## Scope and method

Targeted debug work on Local and Remote Gateway selection, using source tracing, rendered DOM
regressions, deferred promises, and fake timers. Existing sessions preserve their current model
and thinking selection when switching Gateways. Creation forms resolve the selected Gateway's
default model without briefly displaying an empty/default value.

```review-scope
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/hooks/useSessionCreationProjection.ts
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/components/new-session/useRemoteSessionCreation.test.tsx
src/renderer/components/SessionDetail/composer-sdk/SessionRuntimeControls.tsx
src/renderer/components/SessionDetail/RemoteSessionRuntimeControls.tsx
src/renderer/components/SessionDetail/SessionRuntimeControls.gateway.test.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/__tests__/NewSessionDialog.gateway.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Existing Local and Remote sessions cleared the model whenever a Gateway was selected, changing the next-turn model as well as blanking the input. | Change only the provider in the runtime draft. Preserve the current model and thinking in the persistence payload, including pending explicit model edits and a return to native configuration. |
| MEDIUM | Creation forms immediately displayed the cleared model while a same-adapter Gateway read was pending; the 120 ms debounce made the transition more noticeable. | Retain a separate display model, keep submitted overrides clear, and start Gateway reads immediately. Fast results replace the displayed value directly; slow reads retain the model and reveal existing progress at 150 ms. |
| MEDIUM | A rapid Remote return to a previously resolved Gateway could reuse its old readiness descriptor; in-flight reads also reconciled a captured authoring state instead of newer model edits. | Include the request revision in readiness identity and reconcile the latest authoring state. Preserve explicit edits and ignore stale responses. |

## Validation and evidence

- Focused renderer regressions: 7 files, 79 tests passed.
- `pnpm typecheck`: architecture boundaries and both TypeScript projects passed.
- `pnpm test`: 1,029 files passed and 2 skipped; 6,386 tests passed and 3 skipped.
- Timing assertions cover no creation progress at 149 ms and progress at 150 ms, with the old
  model retained until resolution. Tests verify final submission payloads, empty configured
  defaults, rapid Gateway changes, read failure, reopen, and explicit model edits.
- Local/Remote runtime assertions cover unchanged models and thinking, delayed acknowledgements,
  consecutive changes, failures, replacement sessions, and native-Gateway selection.
- Ran the repository file-level review-expiry script before finalizing this targeted record.
- `git diff --check` passed.

## Residual risk

- Installed-app visual acceptance was not performed; validation used renderer DOM tests. No
  application process or installed bundle was stopped, replaced, or restarted.
- All changed production files remain below 500 lines. The existing
  `src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx` remains 809 lines with only
  one corrected payload assertion. Splitting its shared composer/queue/permission fixture was
  evaluated and deferred because it would restructure unrelated test coverage. New Gateway tests
  live in a separate suite; revisit the existing file during the next composer-test restructuring.

## Follow-ups

No additional source change is required for this defect. Development renderer changes use HMR;
an installed build receives the fix through the normal later packaging/update workflow.

Related plan: `ref/plans/recent-3-days/PLAN_54_gateway-model-presentation.md`.
