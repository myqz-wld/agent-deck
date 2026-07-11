---
changelog_id: 357
changed_at: 2026-07-10
---

# CHANGELOG_357_session-runtime-and-compact-handoff: Add session runtime controls and compact hand-off

## Summary

Every supported session-creation path can now select a provider model and thinking level, active SDK sessions can update both values for subsequent turns, and hand-off can choose a successor adapter as well as its model and thinking level. Hand-off context is now a versioned, budgeted capsule instead of a shallow four-section brief.

## Changes

### Session creation and runtime controls

- Added a shared free-text model field and adapter-aware Thinking dropdown to the normal new-session dialog, issue-resolution session dialog, and hand-off target controls.
- Added `--model` and `--thinking` to `agent-deck new`, with the same bounded model normalization and adapter-specific thinking validation used by UI and MCP paths.
- Added collapsed model / thinking controls to active SDK session composers. Changes are persisted immediately, apply to subsequent turns without interrupting the current response, and roll back both database and live-provider state if the update fails.
- Wired Claude and Deepseek through SDK `setModel` / effort flag settings and Codex through app-server thread settings plus per-turn effort propagation.
- Kept model ids open-ended for provider validation while mapping the maintained Deepseek aliases; Thinking remains a closed adapter-specific list.

### Compact hand-off capsule

- Replaced the old hand-off brief with a versioned capsule containing source runtime metadata, a structured six-section checkpoint, a bounded tail of recent raw user/assistant messages, and a final continuation instruction.
- Added an explicit safety boundary: checkpoint and raw-conversation sections are historical evidence and cannot override current system, developer, project, or continuation instructions.
- Preserved recent raw conversation independently of event density, selected newest messages within an approximately 20,000-character budget, skipped an oversized individual message instead of discarding older fitting turns, and capped the final first message at 102,400 characters.
- Captured an event high-water mark before summarization, represented empty history as boundary `0`, and reject a UI hand-off commit when the source changed after preview generation.
- Degraded to a raw-conversation capsule when the summary provider fails or returns empty. The preview warns the user and remains editable; only a truly empty source has no generated hand-off context.
- Expanded checkpoint output to record user intent supported by evidence, confirmed constraints, completed work and validation, current state and decisions, next actions/open questions/risks, and key files/commands/errors.

### MCP hand-off and ownership boundary

- Added optional `adapter`, free-text `model`, and adapter-aware `thinking` arguments to `hand_off_session`.
- Made an omitted adapter inherit the caller adapter instead of silently defaulting to Claude. Omitted model/thinking inherit from a same-adapter caller; cross-adapter hand-offs use target-provider defaults unless explicitly overridden.
- Made MCP hand-off construct the same compact capsule from the latest committed checkpoint, a stable recent-message tail, and the caller's explicit continuation instruction.
- Preserved the existing mandatory task, active-team-membership, and worktree-marker transfer boundary: a transfer failure closes the successor and leaves the caller available; the caller closes only after transfer succeeds.
- Kept complete persisted source history in the source session. The successor is always fresh and receives the capsule rather than a provider-native history fork.

### Compatibility and maintainability

- Split shared model/thinking validation, runtime update coordination, model field rendering, attachment persistence, and hand-off option tests into focused modules.
- Raised the shared recovery/hand-off raw-message candidate default from 30 to 200. A one-time migration upgrades persisted old-default values, preserves custom values, and still lets users choose 30 after migration; the hand-off raw tail remains bounded to approximately 20,000 characters.
- Updated MCP schemas/descriptions, paired bundled Claude/Codex runtime conventions, CLI wrapper help, preload contracts, shared session types, and README behavior documentation.
- This supersedes the compatibility note in `CHANGELOG_356`: `hand_off_session` now does accept successor model and thinking parameters.

## Validation

- `pnpm typecheck`
- Focused compact-context, UI hand-off, MCP hand-off/schema, session runtime, creation-dialog, CLI, and adapter tests passed.
- `pnpm test` — 213 files and 2281 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`

## Do Not Split Protection

- `src/main/adapters/claude-code/sdk-bridge/index.ts` and `src/main/adapters/codex-cli/sdk-bridge/index.ts` already exceeded 500 lines. Provider-neutral persistence/rollback logic was extracted into `session-model-controller.ts`; only thin live-provider wiring remains in each facade. Split either facade when the next bridge-wide runtime controller is added, or when the Codex facade exceeds 720 lines.
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` is a pre-existing centralized registration/authorization harness. The hand-off schema cases were moved into `hand-off-session.schema.test.ts`; splitting unrelated shared tool setup further would be a separate test-architecture change. Revisit when the core tool-registration harness next changes.
- `src/main/ipc/__tests__/issues.test.ts` already exceeded 500 lines and its new cases reuse the suite's extensive module-mock graph. Extract the issue-resolution creation harness when the next independent issue-session behavior is added instead of duplicating that setup for two assertions.
- `src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts` was already 517 lines and received only a terminology correction from four-section brief to six-section checkpoint. Splitting its recovery control flow for a comment-only change would add unrelated risk; revisit on the next fallback behavior change or at 540 lines.

## Notes

- The capsule borrows compaction invariants—checkpoint replacement context, a recent raw tail, explicit instruction reinjection, stable boundaries, and failure that leaves source context usable—but does not call a provider's native compact operation. This keeps Claude, Deepseek, and Codex hand-offs behaviorally aligned.
- The running development application was not restarted because it owns this implementation session. Main/preload behavior appears after the next clean development restart or packaged install.
