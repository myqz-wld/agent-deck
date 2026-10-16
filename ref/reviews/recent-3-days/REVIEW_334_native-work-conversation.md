---
review_id: 334
reviewed_at: 2026-10-15
baseline_commit: 235255031b85038b29e0bcb537cc37b8a26668ee
expired: false
---

# Native conversation presentation follow-up

## Scope and method

Lead-owned inspection and regression validation of the owner's presentation corrections. This
record does not claim independent paired review or live inference/cancellation coverage.

```review-scope
src/contracts/native-work.ts
src/contracts/native-work.test.ts
src/main/adapters/native-work-tracker.ts
src/main/adapters/native-work-tracker.test.ts
src/main/adapters/claude-code/sdk-bridge/native-work-core.ts
src/main/adapters/claude-code/sdk-bridge/native-work-core.test.ts
src/main/adapters/codex-cli/native-work.ts
src/main/adapters/codex-cli/native-work.test.ts
src/main/adapters/grok-build/native-work.ts
src/main/adapters/grok-build/native-work.test.ts
src/main/store/native-work-repo.ts
src/main/store/__tests__/native-work-repo.test.ts
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/SessionDetailShell.tsx
src/renderer/components/activity-feed/rows/tool-result.tsx
src/renderer/components/activity-feed/rows/tool-end-row.tsx
src/renderer/components/activity-feed/tool-status.ts
src/renderer/components/native-work/NativeWorkDetails.tsx
src/renderer/components/native-work/NativeWorkStrip.tsx
src/renderer/components/native-work/useNativeWork.ts
src/renderer/components/native-work/useNativeWorkRecords.ts
src/renderer/components/native-work/conversation-events.ts
src/renderer/components/native-work/conversation-events.test.tsx
src/renderer/components/native-work/command-context.tsx
src/renderer/components/native-work/command-context.test.tsx
src/renderer/components/native-work/native-work.test.tsx
```

The expiry helper exited during legacy scope mapping. A manual per-file fallback classified
the changed source/test scope as 21 unreviewed, 3 expired and 3 current files; all were included
in this inspection. The removed `NativeWorkHistory.tsx` surface was also checked for remaining
imports and Local/Remote consumers. This is not a repository-wide review renewal.

## Findings and repairs

1. The old child panel rendered generic records and fetched oldest-first pages. Changing only
   the visible array would still open old history for long conversations. The repository now
   provides descending cursor pages, while record parts join in ascending part order. Tests
   exercise page boundaries, no duplicate rows, complete multilingual text, and DOM order.
2. Explicit child tool identities were discarded, so existing conversation rows could not pair
   input and output. Metadata is now retained as bounded optional fields, with opaque tool keys
   and attempt-scoped presentation identities. Status-only changes publish a new detail revision.
   Streaming output without a loaded start stays in its correct newest-first position.
3. Grok background snapshots previously omitted `tool_call_id`. They now preserve it within the
   same task attempt, without carrying an old call into a reused registry ID. The renderer also
   requires matching session, provider and parent-child ownership before binding command output.
   Codex uses its original main conversation output and does not issue a duplicate detail read.
4. Claude/Grok's initial background-registration result is not the command's terminal status,
   exit code or duration. Associated native task state controls the displayed status; registration
   metrics are not presented as real command completion metrics. Opening output loads the bounded
   command records lazily, and final output refresh preserves the disclosure state.
5. Tasks and non-Activity tabs no longer expose the native strip/history. Native commands with
   missing associations keep their original tool rows; no text/time matching or fallback card
   is introduced. The original stop/hide/reorder behavior remains for subagents.

## Validation and evidence

The focused suite passed 45 tests. Typecheck, 7,533-test full regression and production build
passed. The later panel-toggle removal was followed by 15 affected renderer tests, typecheck
and a rebuilt Browser preview. The owner then approved merging the inner Activity/Output tabs;
19 affected renderer tests and typecheck passed after removing the filter and tab controls.
Browser snapshots and an inspected screenshot confirmed that messages, thinking and Bash appear
together with newest records first. Release preparation then reran typecheck, the full suite
(7,533 passed, 6 skipped) and the production build successfully on the final source.
Full results and Browser coverage are recorded in
[CHANGELOG_687](../../changelogs/recent-3-days/CHANGELOG_687_native-work-conversation.md).

Browser used only the bundled session-scoped CLI. The preview imports production shell,
conversation, composer and strip components; its synthetic fixture has a minimum page height
so a short IAB viewport can scroll through the complete example. No host window was resized.
The inspected screenshot shows the latest assistant message above Bash, thinking and the earlier
user prompt. Console capture was empty. The tab remains open with a child expanded; the final
show request returned `visible: false`, so foreground display is not claimed.

## Residual risk and follow-up

- Old detail records cannot acquire metadata they never stored. They remain readable but may
  lack pairing/role fidelity. Missing command association does not create a history fallback.
- Adapter observer fixtures and real renderer/storage tests do not establish live Claude/Grok
  output delivery or cancellation behavior. No new inference or task cancellation was performed.
- The existing gesture regression suite passed in the full run; Browser checks did not automate
  native pointer dragging. Remote preview mode is synthetic and does not exercise a live server.
- The additive query field requires an updated runtime for descending reads. No schema version
  changed and no dependency was installed/rebuilt during implementation validation. Application
  replacement is a separate owner-authorized release step.
- This correction does not change answer persistence. The previous repair remains documented
  separately in REVIEW_333.
