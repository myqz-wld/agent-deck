---
review_id: 283
reviewed_at: 2026-09-28
baseline_commit: b9ee1bd71af44e3b90aab5d94dece332a1f33daf
expired: true
---

# Session Content Presentation Audit

## Scope and method

Inspect the supplied session-detail screenshot, shared renderer, and Claude/Codex/Grok event
translation. The user requested display/icon recommendations, identified missing math rendering,
and explicitly retained English `REASONING SUMMARY` and `THINKING` labels. Trace fields already
available to the renderer separately from information discarded by an adapter.

The user excluded extra input access when a tool's start record is outside the loaded page.
Keep the existing start record as the entry point for full input; tool calls normally remain
visible on the current page.

This is a source inspection and presentation inventory, not a paired reviewer pass. The math
renderer change is implemented and validated. The remaining rows below are proposed improvements,
not claims of fixes at the time of that audit. The confirmed follow-up scope is now implemented;
see the [delivery review](REVIEW_284_session-content-image-chain.md). This historical inventory
remains expired.

```review-scope
src/renderer/components/MarkdownText.tsx
src/renderer/components/MarkdownText.test.tsx
src/renderer/components/markdown/remark-chat-math.ts
src/renderer/components/markdown/math.css
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/tool-icons.ts
src/renderer/components/activity-feed/tool-status.ts
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/rows/tool-end-row.tsx
src/renderer/components/activity-feed/rows/thinking-row.tsx
src/renderer/components/activity-feed/rows/simple-row.tsx
src/renderer/components/activity-feed/viewers/message-content.ts
src/main/adapters/claude-code/hook-lifecycle-translate.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/result-outcome.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/app-server/translate-collab.ts
src/main/adapters/codex-cli/app-server/translate-display-items.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/hook-translate.ts
```

## Findings: received information with incomplete presentation

| Priority | Scope | Evidence | Proposed presentation |
|---|---|---|---|
| MEDIUM | All adapters: turn outcome | `describe()` renders every `finished` event as a checked completion regardless of `ok`, `subtype`, or `failureReason`. Codex interruption and provider failure are explicitly represented upstream. | Distinguish successful completion, interruption/cancellation, and failure; expose a useful reason such as context exhaustion. |
| MEDIUM | All adapters: tool failure | `ToolEndRow` selects `toolResult ?? toolResponse ?? error ?? reason`. An empty or nonempty result can hide a separate error/reason; unknown status detail appears only in the no-output branch. | Show output and failure reason independently, with exit code, status detail, duration, and truncation kept readable. |
| MEDIUM | Codex and applicable Grok events: live output | `aggregatedOutput` is retained on tool-start events and merged by the shared store, but `ToolStartRow` only exposes input/diff/prompt. | Add an expandable output region while a tool is executing, preserving accumulated output as the event updates. |
| MEDIUM | Claude/Grok terminal Hook subagents | Hook translators preserve `lastAssistantMessage`; Grok also preserves description/phase. `describe()` only shows type or id. Claude Hook stop payloads may additionally contain background tasks/crons. | Show agent identity and phase, with a bounded expandable result. Expose background-work metadata when actually present; do not imply the SDK always supplies it. |
| LOW | Grok tool summaries and icons | `read_file` resolves to `Read`, whose summary reads only `file_path`; a `path` input is omitted. `toolIcon()` lets explicit `other` select the generic icon before examining a specific known tool name. | Recognize current adapter field spellings and prefer a specific known semantic icon over generic `other`. Keep unrecognized input accessible. |
| LOW | Codex display-tool results | ImageView/ImageGeneration/clock.sleep events have path, prompt, savedPath, and duration fields, but no dedicated input summary/icon. Child-agent `agents_states` remains raw expanded output. | Use image/clock icons and short path/prompt summaries; render child-agent states as compact status rows while preserving raw detail. |
| LOW | Compaction detail | Hook compaction summaries are reduced to 100 characters without an expansion. | Add a full-summary disclosure. |

## Findings: information lost before rendering

| Priority | Scope | Evidence | Proposed change |
|---|---|---|---|
| MEDIUM | Codex plan/progress/advisory events | `translateCodexAppServerNotification()` returns immediately for `turn/plan/updated`, `item/mcpToolCall/progress`, and warning/config-warning variants. | Retain plan steps and current step, bounded MCP progress, and actionable provider warnings. Define update identity/coalescing before adding rows so progress updates do not flood the feed. |
| MEDIUM | Grok structured plans and late tool arguments | Plan conversion retains only checked/unchecked status, losing in-progress/priority distinctions. `plan: true` is ignored by `ThinkingBubble`. Tool-call updates with an existing start do not emit enriched `rawInput`. | Preserve structured plan fields and identify PLAN separately from THINKING. Merge late arguments into the same tool event and keep the progress title separate from its stable tool identity. |
| MEDIUM | Grok assistant media | `contentEvents()` replaces an image with placeholder text and mime/URI/length metadata, omitting bytes; other non-text content only flushes buffered text. Message normalization does not consume that image metadata. | Add an owned attachment/resource path for supported media, with bounded previews and Local/Remote source checks. A renderer-only image component cannot recover bytes that were never retained. |

## Existing presentation to preserve

- Claude's SDK permission, question, and plan approval rows, including the separate terminal-only
  plan notice, already carry meaningful interactions. Do not flatten them into generic tool rows.
- Claude and Codex Agent/Task rows already show prompts, target, model/effort, fork settings,
  timeouts, and raw inputs where available. Keep those disclosures during any row consolidation.
- File changes have a separate paged diff view, and usage/context have dedicated surfaces.
  A compact activity row is not evidence that those features are entirely missing.
- Grok intentionally does not advertise ACP notices/compaction capabilities. Enabling them needs
  a lifecycle/storage contract; do not simply render every currently ignored protocol variant.
- Preserve the user-requested English thought labels and original provider tool identifiers.
- Consolidate start/completion rows only by reliable call identity. Retain input available in
  matched events, output, specialized disclosures, and errors. Preserve unmatched rows as they are.
- Replace tool emoji with source-owned semantic SVGs using the existing icon primitive. Terminal,
  browser, file, search, task, collaboration, wait, and MCP actions should remain distinguishable.

## Implemented change and validation

At the initial audit, only the shared math renderer and its dependencies/tests/documentation
had been changed. See [CHANGELOG_651](../../changelogs/recent-week/CHANGELOG_651_markdown-math-rendering.md)
for the 13 focused tests, full-suite/typecheck/build results, local-font checks, and actual Browser
visual evidence. No live provider prompt was sent and no host runtime was restarted or replaced.

`bash scripts/file-level-review-expiry.sh` ran before the inspection. Previous records did not
exempt any file from this requested display audit. Source evidence above does not establish how
frequently optional provider fields occur in the user's live sessions.

## Follow-up order

1. Correct turn outcomes and tool error/output disclosure.
2. Consolidate tool rows and adopt semantic SVGs while preserving specialized Claude interactions.
3. Add structured plans/progress and richer provider media after defining their normalized event,
   persistence, and Local/Remote rendering contracts.

## Follow-up resolution

The user authorized direct implementation. All recommendations within the confirmed scope were
implemented with generated-image support across the three adapters. Cross-page input retrieval
remains excluded. See [REVIEW_284](REVIEW_284_session-content-image-chain.md) for the source/test
results and remaining runtime and historical-data limits.
