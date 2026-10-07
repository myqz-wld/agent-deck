---
review_id: 289
reviewed_at: 2026-09-29
baseline_commit: 1c3b4449
expired: true
---

# Inline diff spacing and presentation readiness

## Scope

Lead inspection and regression checks for the reported expanded-file gap and transient loading
text, plus the requested concise English README. This is not independent paired review.
The expiry inventory was attempted; its legacy empty-scope pipeline exited early. All changed
files below were inspected directly, without claiming exemptions from earlier reviews.

```review-scope
README.md
resources/README.md
src/main/codex-config/__tests__/bundled-browser-skill.test.ts
src/renderer/components/activity-feed/file-change-row.test.tsx
src/renderer/components/activity-feed/rows/file-change-row.tsx
src/renderer/components/diff/DiffViewer.tsx
src/renderer/components/diff/LoadingContext.ts
src/renderer/components/diff/renderers/MonacoDiffView.tsx
src/renderer/components/diff/renderers/MonacoDiffView.readiness.test.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.tsx
```

## Findings and fixes

- LOW: A separate expand-action toolbar added a mostly empty row above the diff. Move its button
  beside the outer file title and reduce top padding. Keep buttons separate and keyboard reachable.
- MEDIUM: Payload loading, lazy imports and Monaco initialization had separate presentation states,
  including an immediate fallback and Monaco's default English loading text. Share the existing
  150 ms grace period across payload/editor initialization, keep one loading message, reserve preview
  height and reveal the editor only after diff computation and initial layout. Reset readiness for
  changed content and fence callbacks from disposed models.
- Reduce the root README to 47 English-only lines: overview, features, quick start, core commands
  and documentation links. Move the Browser lifecycle/annotation detail to `resources/README.md`
  and update its documentation assertion. Bundled runtime prompts and Skills are unchanged.

## Validation

- Focused inline row, text renderer and readiness regressions: 24 passed. Browser documentation
  contract regressions: 4 passed after moving their detailed-document target.
- `pnpm typecheck` passed. The first full suite exposed the old root-README assertion; it was
  corrected without restoring verbose root documentation. The final `pnpm test` run passed
  6,587 tests across 1,068 files, with 3 existing skipped tests in 2 files.
- A temporary loopback fixture used the production components, real local Monaco and synthetic
  YAML through the session-scoped Browser CLI. No live project payloads or credentials were used.
- Cold editor: loading appeared at 157 ms and cleared when ready at 561 ms. Cached reopen completed
  at 118 ms with no loading message. With a 500 ms payload delay, loading appeared at 154 ms,
  persisted across editor mount at 505 ms and cleared at 938 ms. No English loading state occurred.
- The captured narrow viewport showed a 4.375 CSS-pixel gap between the outer title row and inner
  header. Enlargement and close controls worked. Verification covers this synthetic viewport and
  observed state transitions, not every display size or a full installed-app session.
- The Browser tab and temporary fixture server were closed. README local links exist and it
  contains no Han characters. All changed source files remain below 500 lines.

## Residual risk and activation

The 150 ms value controls when progress appears; cold Monaco initialization can take longer.
Slow paths retain progress until a computed diff is ready. Actual timings depend on the machine.
The fix is installed in clean `3bb45616`; authorized application replacement and Worker/Relay
acceptance completed under REVIEW_288. The credential issue is resolved and the final plan is
[PLAN_63](../../plans/recent-month/PLAN_63_grok-credential-installed-acceptance.md).
