---
changelog_id: 688
changed_at: 2026-10-16
---

# Dialog and expanded panel translucency

## Summary

Settings and other shared dialogs, expanded panels and subagent conversations now have lightly
translucent surfaces when transparent-window mode is enabled. Opaque mode keeps their solid surfaces.

## Changes

- Derive a shared 94% surface opacity from the existing transparent frame attribute. Inherit it
  from the document root so confirmation dialogs portaled outside the frame also follow the mode.
- Apply it to shared dialog chrome: settings, new sessions, assets, remote hosts, handoff and logs.
  Reuse it for subagent details, expanded input/diff/review surfaces and slash-command suggestions.
- Include read-only expanded content, dropdowns, context menus and the subagent drag preview.
  Existing translucent surfaces keep their ordinary-mode base and gain slight transparency only
  when transparent-window mode is enabled. Remove the redundant plan-review background layer.
- Preserve each surface's original RGB color, border, text and control opacity. Popup Monaco
  editors retain one translucent theme background instead of stacking opaque editor/gutter layers;
  plain diff/conflict backgrounds follow their containing popup. Inline editors retain their base.
  Do not add new backdrop filters or colored gradients.
- Reuse Local/Remote components without changing layout, controls, persistence or settings behavior.
- Keep README unchanged: this cosmetic adjustment does not introduce a new usage step.
- Rebucket CHANGELOG_643 into history after its recorded date passed the 30-day boundary.

## Validation

- `pnpm typecheck` passed, including architecture checks.
- All renderer tests: 1,182 passed across 182 files. Update the existing expanded-input and
  read-only surface assertions, including the new-session editor's shared input style.
- Release preparation full suite: 7,533 passed, 6 skipped across 1,200 files.
- `pnpm build` passed. The existing Electron native binding was preserved.
- Rebuilt the production-component IAB preview and inspected settings screenshots in both modes.
  Computed background alpha is 0.94 in transparent mode and 1 in opaque mode; panel opacity stays 1,
  with identical original RGB, text and border colors. Body-portaled dialogs follow both modes.
  Menus/read-only expansion retain approximately 0.78 alpha in ordinary mode and use approximately
  0.734 in transparent mode. Real Monaco log/diff editors preserve foreground colors and opacity
  while their base alpha switches between 1 and 0.94. Console capture was empty.
- The preview has temporary mode switches and preserves its original neutral background.
  It remains open with settings in transparent mode. This checks real renderer components with
  synthetic data, not native desktop composition, live settings writes or a new installed build.
  Source inventory, per-surface Browser coverage and retained boundaries are recorded in
  [REVIEW_335](../../reviews/recent-3-days/REVIEW_335_overlay-transparency-coverage.md).
- `git diff --check`, file-size, local-link and path-privacy checks passed.

## Do Not Split Protection

None. Changed source files remain below 500 lines. Preview controls are non-final scratch material
under `.ref/prototypes/native-work-production/`. No application restart or installation occurred.
