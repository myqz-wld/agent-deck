# REVIEW_138

## Trigger Context

The user asked to improve the diff walkthrough presentation contract across Agent Deck MCP tool descriptions and Skill Market `diff-walkthrough` skills.

The change is prompt-asset-only:

- Agent Deck MCP `present_diff` tool and schema descriptions.
- Skill Market Claude/Codex `diff-walkthrough` skills.
- Skill Market `skills/INDEX.md` catalog version bump to `0.0.2`.

## Method

Ran `simple-review` with heterogeneous reviewers:

- reviewer-codex session `019ef390-dbde-7661-bea3-aeaa0ee97b6c`
- reviewer-claude session `cf0de756-2475-49a1-bb5b-57483a362a8f`

Skill Market files were copied into `.deep-review-cache/sr-diff-walkthrough-20260623/` for single-root review. The cache was used only for review readability and was removed after adjudication.

## Decision List

### LOW: Skill capability wording implied every tool returns literal stop

Status: fixed.

Reviewer-claude noted that the Skill Market body said the tool blocks until a structured "approve, revise, or stop decision", while Agent Deck `present_diff` returns `approved`, `revise`, or `timeout`.

Fix:

- Rephrased the portable skill capability as a structured approve/revise decision or a stop/end signal.
- Kept the walkthrough loop rule that user stop or timeout ends the walkthrough.

### LOW: MCP walkthrough loop only mentioned timeout stop

Status: fixed.

Reviewer-claude noted that the MCP self-description said to stop on timeout, while the skill also supports user-initiated stop.

Fix:

- Updated the `present_diff` self-description to end the walkthrough if the user stops or the request times out.

### INFO: Runtime baseline prompt assets are not expanded

Status: accepted.

`resources/claude-config/CLAUDE.md` and `resources/codex-config/CODEX_AGENTS.md` still contain the shorter `present_diff` guidance. Both counterparts remain aligned, and the expanded walkthrough behavior lives in the tool self-description and Skill Market skill body where agents will inspect it for this workflow.

### INFO: Catalog summary still says confirmation

Status: accepted.

The Skill Market catalog summary remains a short trigger/catalog row. The executable skill body now uses approve/revise/stop/timeout loop language.

## Validation

- `pnpm typecheck`
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts`
- Agent Deck `git diff --check` for changed MCP/changelog/plan files.
- Skill Market Ruby frontmatter/YAML parse for changed skills and metadata.
- Skill Market Claude/Codex skill identity check.
- Skill Market concrete tool/server/product-name portability scan.
- Skill Market catalog version check for `diff-walkthrough` `0.0.2`.
- Skill Market `git diff --check`.

## Related Changelog

CHANGELOG_320.
