---
review_id: 263
reviewed_at: 2026-08-24
baseline_commit: 831094f7399b2a6d651f881cce0d877053d6600c
related_changelog: CHANGELOG_629
expired: false
---

# REVIEW_263_session-settings-clarity: Session settings clarity and Hook timeout review

## Scope and method

This local review traced the reported Codex warning to the generated hook entry, checked the shared
terminal-Hook layout across all three adapters, and reviewed every project-trust message rendered by
the shared session form. It then exercised focused regressions, the full test suite, and both
TypeScript projects.

```review-scope
src/main/adapters/codex-cli/__tests__/hook-installer.test.ts
src/main/adapters/codex-cli/hook-installer.ts
src/renderer/components/__tests__/NewSessionDialog.project-trust.test.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/settings/sections/HookSection.tsx
src/renderer/components/settings/sections/__tests__/HookSection.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| LOW | Agent Deck wrote a five-second timeout for Codex `SessionEnd`, while the installed Codex runtime accepts at most three seconds and warned on every configuration load. | Use three seconds only for `SessionEnd`; keep five seconds for other events and detect the old value as repairable. |
| LOW | Stable action content preserved the long install-label width after installation, but the Hook button itself did not fill the card, leaving a visibly arbitrary partial-width uninstall action. | Apply one full-width contract to install, repair, and uninstall states and cover the installed state. |
| LOW | Project-trust help and fallback notes exposed implementation vocabulary without first explaining the user-visible consequence. | Rewrite the copy around remembered trust, loaded resources, and separate authorization while retaining clear domain terms such as hooks and MCP. |

## Validation and evidence

- The installed Codex CLI emitted the exact clamp warning for the prior five-second `SessionEnd`
  entry and read the corrected three-second entry without warning.
- Codex hook-installer coverage asserts five seconds for ordinary events, three seconds for
  `SessionEnd`, and a partial status for a legacy five-second entry.
- Renderer coverage verifies provider-specific trust copy and the full-width installed Hook action.
- `pnpm typecheck` passed architecture checks and both TypeScript projects.
- `pnpm test` passed 1,007 files and 6,309 tests; 2 files and 3 opt-in tests were skipped.
- `bash scripts/file-level-review-expiry.sh` completed before finalizing this record.
- `git diff --check` passed.

## Residual risk

- The three-second ceiling belongs to the Codex runtime and could change in a future release. A
  changed ceiling would require updating the generated value and the same repair predicate.
- Visual verification in a restarted packaged app remains pending because restarting the active app
  would terminate this in-app session; the shared width class and renderer regression cover the
  layout contract in source.

## Verdict

PASS. All three reported issues are fixed with no open CRITICAL, HIGH, MEDIUM, or LOW finding in the
reviewed scope.
