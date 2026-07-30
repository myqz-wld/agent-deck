---
changelog_id: 413
changed_at: 2026-07-29
---

# CHANGELOG_413_session-ui-scope-alignment: Restore scoped session UI

## Summary

Keep chat expand controls scoped to chat authoring, restore the asset library's compact controls,
make the new-session editor visually correct, and align runtime-control labels in session views.

## Changes

- Remove the redundant full-screen expand control from every Skill and Agent asset card.
- Preserve the existing asset `查看` action as the single full-content entry point.
- Restore compact vertical padding for the Claude Code, Codex CLI, and Grok Build adapter tabs.
- Keep the chat input's upper-right expand control unchanged.
- Size and position the new-session input's expand button like the regular chat composer instead
  of using the shared 44-pixel trigger.
- Disable drag resizing for that input so the upper-right expand action is the only resize
  interaction.
- Group the new-session message editor and image action under a local compact gap instead of
  inheriting the form's wider section spacing.
- Give the new-session expanded editor an opaque background so underlying text cannot bleed
  through.
- Reserve the macOS window-control area in the new-session expanded header to prevent overlap.
- Align session-page runtime controls under the short labels `审批`, `权限`, `沙盒`, and `模式`
  without adapter-name prefixes.
- Add regression coverage for the absence of asset-card expand controls and compact tab sizing.
- Add regression coverage for the new-session overlay background and header inset.

## Validation

- `pnpm vitest run src/renderer/components/assets/AdapterSubTab.test.tsx src/renderer/components/assets/AssetsTab.test.tsx src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx`
- `pnpm vitest run src/renderer/components/assets/AssetsTab.test.tsx src/renderer/components/assets/AssetCard.test.tsx src/renderer/components/assets/ApplicationConventionTab.test.tsx`
- `pnpm vitest run src/renderer/components/__tests__/NewSessionDialog.test.tsx src/renderer/components/expandable-content/__tests__/ExpandableContent.test.tsx src/renderer/components/assets/AdapterSubTab.test.tsx src/renderer/components/assets/AssetsTab.test.tsx`
- `pnpm vitest run src/renderer/components/SessionDetail/__tests__/SessionSandboxControls.test.tsx src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx src/renderer/components/__tests__/NewSessionDialog.test.tsx src/renderer/components/expandable-content/__tests__/ExpandableContent.test.tsx`
- `pnpm test` (467 files passed, one intentional smoke skipped; 4,001 tests passed, one skipped)
- `pnpm typecheck`
- `pnpm exec tsc --noEmit -p tsconfig.web.json`
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

- Not applicable. The production changes are small, scoped renderer corrections.
