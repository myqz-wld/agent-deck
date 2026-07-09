---
plan_id: ask-user-question-notes-20260615
status: completed
created: 2026-06-15
base_branch: main
base_commit: b65a0bf
worktree: /Users/wanglidong/Repository/agent-deck
---

# Goal

Support Claude Code AskUserQuestion user notes in Agent Deck's existing SDK/UI answer path.

# Invariants

- Preserve the existing AskUserQuestion pending UI and `deny.message` response mechanism.
- Do not depend on undocumented runtime behavior for `annotations.notes`.
- Keep existing `other` free-text answer compatibility.
- Notes must be per question, available from renderer through IPC to the SDK bridge formatter.
- Codex adapter remains unchanged because it has no AskUserQuestion support.

# Design Decisions

- Add a `note?: string` field to Agent Deck's `AskUserQuestionAnswer.answers[]` contract.
- Render note as a separate textarea/input in `AskRow`, distinct from the existing "other" answer field.
- Include notes in `formatAskAnswers()` output as `备注：...`, so Claude receives them through the stable existing message channel.
- Avoid switching AskUserQuestion to `allow + updatedInput` in this change; that is a separate protocol migration and current code history documents why Agent Deck uses `deny.message`.

# Checklist

- [x] Read project instructions and relevant AskUserQuestion history.
- [x] Update shared AskUserQuestion answer type.
- [x] Update renderer AskRow state, UI, and submission payload.
- [x] Update SDK bridge answer formatter and tests.
- [x] Add changelog entry and index row.
- [x] Run targeted tests and typecheck.

# Validation

- `pnpm vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-bridge-helpers.test.ts` — 2 passed.
- `pnpm typecheck` — passed.

# Risks

- UI could become crowded; note field is compact and consistent with existing row styling.
- The formatted output is model-facing text; tests pin note inclusion without over-constraining unrelated copy.

# Next-Session First Action

No follow-up required for this plan.
