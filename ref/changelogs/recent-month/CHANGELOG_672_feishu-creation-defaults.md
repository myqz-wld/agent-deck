---
changelog_id: 672
changed_at: 2026-10-01
---

# Prefill editable Feishu assistant creation defaults

## Summary

The Feishu assistant form starts with the same concrete defaults as remote session creation and
lets the owner edit and save them. It shares the adapter, Gateway, model, and thinking controls
used by summary and continuation settings, with choices supplied by the selected remote host.

## Changes

- Resolve missing assistant, Gateway, model, thinking, mode, and sandbox values from the remote
  creation capabilities. Keep saved explicit choices and unsupported selections visible.
- Populate the model input with the resolved model instead of using its name as placeholder text.
  Save the complete displayed configuration; an unconfigured assistant can save its initial form
  directly. Opening the form does not write preferences or start an assistant.
- Supply remote adapter, Gateway, and thinking catalogs to the shared settings fields. Remote
  editing never discovers Gateways from the local desktop.
- Resolve each selected Gateway's model and automatic defaults, retaining explicit runtime
  choices and thinking edits scoped to each Gateway in the current form.
- Keep the existing 150 ms grace, stable form presentation, stale-response guards, explicit save,
  revision checks, and failed-save recovery.

## Validation

- `pnpm typecheck` passed, including architecture checks and both TypeScript projects.
- The assistant, summary, continuation, and local/remote settings tests passed: 5 files, 45 tests.
  The added Gateway-memory regression then passed with all 13 assistant settings tests.
- Coverage includes initial concrete defaults, direct first save, Gateway selection and saving,
  per-Gateway thinking memory, no local Gateway reads, unsupported saved options, and the existing
  149/150 ms presentation tests.
- `git diff --check` and staged identifier/credential checks passed.

## Do Not Split Protection

None. Default resolution is isolated in `feishu-preference-defaults.ts`; changed source and tests
remain below 500 lines.

## Notes

Renderer-only change. Development uses HMR; no installed application or remote service was changed.
Shared summary and continuation fields preserve their current defaults and local discovery when
no remote catalog is supplied. No transport schema, prompt asset, or stored data migration changed.
