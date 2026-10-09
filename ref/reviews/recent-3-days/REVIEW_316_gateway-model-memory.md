---
review_id: 316
reviewed_at: 2026-10-09
baseline_commit: 03471440cd6352c890bd663707dade9f5b284bd9
expired: false
---

# Preserve each Gateway's model choice

## Scope and method

Targeted debugging of new-session model memory through source tracing, renderer hook tests,
rendered dialog interaction, and full repository validation. The review-expiry inventory was run;
all changed source was inspected without relying on prior coverage exemptions. No independent
paired review was requested or performed.

```review-scope
src/renderer/hooks/useLastSessionDefaults.ts
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/hooks/__tests__/useLastSessionDefaults.test.ts
src/renderer/hooks/__tests__/gateway-thinking.test.tsx
src/renderer/components/__tests__/NewSessionDialog.gateway.test.tsx
```

## Finding and fixes landed

MEDIUM: switching from Gateway A to B and back discarded A's explicit model. Local creation
stored one model per adapter and cleared it on every Gateway change. Remote creation removed
the model override on every change. Only thinking choices had per-Gateway memory, so later
configuration reads replaced the forgotten model with the configured default.

- Store explicit model and thinking together for each Claude/Codex Gateway, including a separate
  native-default entry. Preserve permission and sandbox memory at the existing adapter scope.
- Restore the selected Gateway's model without deleting other entries. A blank model clears only
  that Gateway's model override; its thinking and other Gateways' choices remain intact.
- Retain Local memory across dialog unmounts. Keep Remote memory within its existing authoring,
  source, and adapter boundaries, and continue validating restored values against capabilities.
- Continue refreshing configuration and project trust. Remembered explicit values take precedence
  over configured defaults; request fencing and pending-read edits remain effective.
- Show a remembered model immediately when available. For an unvisited Gateway, retain the prior
  display until its configuration settles, using the existing readiness and submission gates.

## Validation and evidence

- Before the repair, seven regression cases failed with the reported behavior: a remembered
  model was either shared with another Gateway or replaced by its configured default.
- Focused validation passed 36 tests across five files. Coverage includes both Claude and Codex,
  Local and Remote A/B/A switching, native defaults, edits during pending reads, and submission.
- Final full `pnpm test`: 1,138 files and 7,075 tests passed; three files and six conditional tests
  skipped. Additional assertions cover clearing one Gateway, Local unmount/reopen, and Remote
  source isolation. The Electron SQLite binding checksum was unchanged.
- `pnpm typecheck` passed architecture boundaries and both TypeScript projects.
- `git diff --check` passed; all changed source and test files remain below 500 lines.
- Rebucketed existing review records by their dates and updated affected indexes and references.
  README.md was left unchanged as requested.

## Residual risk

Memory retains its existing lifetime: Local memory lasts for the renderer process, while Remote
memory belongs to the authoring scope. No new disk persistence was introduced. Validation used
renderer DOM tests; the installed application was not replaced or restarted. Development renderer
changes use HMR; an installed build receives the repair through a later packaging/update workflow.

## Follow-ups

None required for this defect.
