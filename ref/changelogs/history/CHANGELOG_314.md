# CHANGELOG_314: Wait for Claude stream drain before restart jsonl precheck

## Summary

Claude restart paths now wait briefly for the previous SDK query stream to finish its cleanup before checking whether the resume jsonl exists. This closes the ExitPlanMode approve-bypass race where `restartWithPermissionMode` could mark jsonl as missing while the old Claude process was still emitting its `session-end` / `[ede_diagnostic]` tail.

## Changes

- Added an `InternalSession.streamDrained` promise and resolver created by `makeInternalSession`.
- Resolved the drain signal from `stream-processor` after its existing `finally` cleanup completes.
- Made `closeSession()` await the drain signal with a 1-second bounded timeout after interrupt and close cleanup.
- Added regression coverage proving `closeSession()` does not return before drain, and does return after the timeout if the stream never drains.
- Updated handwritten `InternalSession` test fixtures to use the shared factory or include the new drain contract.

## Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/exit-plan-hotswitch-and-cancel-resolve.test.ts src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/can-use-tool.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/jsonl-fallback.test.ts`
- `pnpm typecheck`

## Related

- Plan: `ref/plans/claude-restart-jsonl-drain-20260622.md`
- Review: `ref/reviews/REVIEW_134.md`
- Commit: `9469073 fix claude restart jsonl drain race`
