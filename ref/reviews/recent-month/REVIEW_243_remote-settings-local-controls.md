---
review_id: 243
reviewed_at: 2026-08-13
baseline_commit: 45660a7d40fe1ce483a78fd53d6f9645aa5b3b06
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_243_remote-settings-local-controls: Remote settings ownership and layout

## Scope and method

This review traced the settings data source, mutation callback, read-only flags, shared generator
presentation, combobox sizing, and the Remote field-parity test. It then checked the generated CSS,
the complete typecheck and test suite, and a production build.

```review-scope
src/renderer/components/SettingsDialog.remote.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/assets/ProviderCombobox.tsx
src/renderer/components/settings/ProviderModelThinkingFields.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
```

## Findings

### MEDIUM — Current-computer controls inherited Remote read-only state

The dialog correctly loaded reminder, window, and log values from the current computer, but passed
the Remote read-only flag into those sections. The notice therefore claimed that the values belonged
to the current computer while the UI prevented changing them. Those three sections now use the
normal local update path regardless of the selected source; server-owned sections remain disabled.

### LOW — Equal generator columns clipped normal field text

The four generator controls were placed in two equal columns inside a narrow 26 rem dialog. Provider
and model fields need more horizontal space than adapter and thinking fields, and the provider
combobox retained an intrinsic minimum width. The dialog is now 28 rem, the grid uses asymmetric
one/two-column spans, and the combobox can shrink within its assigned cell.

## Validation and evidence

- `pnpm typecheck`: passed.
- `pnpm test`: 960 files passed, 2 skipped; 6,141 tests passed, 3 skipped.
- Focused Settings validation: 3 files and 19 tests passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- Generated CSS includes `width:min(28rem,92vw)` and the 420 px three-column grid and span rules.

## Fixes landed

- Remote view keeps reminder, window, and log controls editable through the current computer's
  settings store.
- The ownership notice now matches actual behavior and explains the fixed shortcut list.
- Generator cards reserve more room for provider and model text without changing field order or
  Remote disabled authority.

## Residual risk

No installed-application screenshot was taken because this renderer-only fix did not restart,
replace, or otherwise disturb the running application. The DOM assertions, generated CSS, full test
suite, and production build define the validation boundary.

## Follow-ups

None required for this scope.
