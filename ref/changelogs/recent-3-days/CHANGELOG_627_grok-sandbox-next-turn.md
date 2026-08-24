---
changelog_id: 627
changed_at: 2026-08-23
---

# CHANGELOG_627_grok-sandbox-next-turn: Apply live Grok sandbox choices next turn

## Summary

Grok Build sandbox choices now remain editable while a Local or Remote session is replying. Agent
Deck saves the requested profile immediately, leaves the current turn untouched, and switches the
ACP child before the next queued turn starts.

## Changes

### Runtime boundary

- Track the requested Grok sandbox separately from the profile used by the active ACP child.
- Persist an active-turn selection immediately so the UI and crash recovery retain the request.
- Gate queue drain on a next-turn boundary that cold-restarts and reloads the Grok ACP child before
  claiming the next message.
- Let an already-required transport recycle consume the staged profile without performing a second
  restart.
- Resume boundary evaluation after model or mode mutations release their runtime lease.
- Restore the previous requested and active profiles when startup, persistence, or rollback fails;
  deferred failures are surfaced in the conversation without interrupting the completed turn.

### Renderer

- Keep the Local and Remote Grok sandbox pickers enabled during active turns and permission waits.
- Update the fully-open confirmation to state that the current reply continues and the choice takes
  effect before subsequent messages.
- Add an accessible `沙盒` name to the Remote picker.

### Coverage

- Cover active-turn staging, next-turn restart ordering, cancellation back to the active profile,
  mutation-boundary resumption, rollback, Local controls, and Remote controls.

## Validation

- Focused Grok runtime and renderer coverage: 6 files and 68 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,002 files and 6,272 tests passed; 2 files and 3 tests skipped.
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

None. All changed production files remain below 500 lines. The next-turn boundary was extracted to
its own module so `bridge.ts` and `turn-queue.ts` remain at 497 and 496 lines respectively.

## Notes

README runtime configuration remains unchanged because it does not document equivalent live
sandbox-switch timing for Claude Code or Codex CLI; this keeps adapter documentation aligned as
requested.

The first full test run hit one transient Remote directory-picker timing failure. Its isolated
rerun and the complete second test run both passed without code changes.

The running installed application was not restarted because the user explicitly requested that no
processes be killed. The new main-process behavior will load on the next normal application start.
