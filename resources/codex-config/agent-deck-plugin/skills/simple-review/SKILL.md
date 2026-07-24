---
name: simple-review
description: "Run exactly one independent review round followed by one bounded rebuttal round with two confirmed heterogeneous reviewer slots. Use for focused code, plan, prompt-asset, technical-decision, agent-validation, or overall-change checks, including 简单 review, 轻量 review, 帮我 review, 这个对不对, 对抗一下, 决策评审, and 整体改动是否符合预期. Present the evidence and recommendation to the user for final judgment; do not start a fix-and-re-review loop."
---

# Simple Review

Run one focused adversarial review and one rebuttal round, then return the final judgment to the user. Use `deep-review` when the work needs iterative fixes, repeated review rounds, or deep architecture, race, lifecycle, security, or performance investigation.

## Shared Review Protocol

### Scope And Authorization

Agent Deck MCP session tools must be available. If `spawn_session`, `send_message`, `get_session`, or `shutdown_session` is unavailable, stop and ask for an Agent Deck-enabled environment or a manual review.

Establish the scope from the user's request:

- Classify the review as code, plan, prompt, technical decision, or a small mixed scope. Ask only when the intent is materially ambiguous.
- Resolve the requested files or current change set, then place absolute paths in reviewer prompts.
- Keep one invocation small enough for a single direct pass. Split a broad scope or use `deep-review`.
- Keep reviewed artifacts read-only. Adding the required `.review-cache/` ignore entry is the only review-infrastructure write; findings do not authorize target edits, commits, or external actions.
- In a worktree, review the worktree copy rather than the base checkout.

### Reviewer Pair

Require exactly two user-confirmed, distinct reviewer slots. If the user has not selected a pair, ask them to choose and stop before spawning.

| Reviewer | Spawn |
|---|---|
| `reviewer-claude` | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| `reviewer-codex` | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |
| `reviewer-grok` | `spawn_session({ adapter: 'grok-build', agentName: 'reviewer-grok', cwd, teamName, displayName, prompt })` |

Reject duplicate slots and every selection that is not exactly two slots. Spawn only the selected pair, concurrently. Record the pair in reviewer prompts and the final report. Do not pass permission or sandbox overrides unless the user requested them.

Keep the pair heterogeneous for the whole invocation. If one selected reviewer fails, shut it down and respawn the same adapter, provider, `agentName`, and model slot; never substitute an unselected slot or duplicate the survivor.

### Shared Review Cache

Use `<reviewRoot>/.review-cache/<invocationId>/` only when a scoped path is outside the absolute reviewer `cwd` (`reviewRoot`).

Before creating or using the cache, ensure `<reviewRoot>/.gitignore` contains the exact `.review-cache/` entry. Add the entry when it is missing. If the ignore file cannot be updated, stop before writing cache files and ask the user to add the entry.

For each invocation:

1. Generate a fresh short `invocationId`.
2. Remove only cache invocation directories whose manifest is older than 24 hours.
3. Copy every external scoped file to `<reviewRoot>/.review-cache/<invocationId>/<fileSha8>-<sanitized-basename>`.
4. Write `manifest.json` in that invocation directory with `invocationId`, `createdAt`, and each original absolute path plus cache path.
5. Send the staged paths to reviewers.
6. On completion or abort, remove only this invocation directory. Report an exact path if staging or cleanup fails.

### Turn Boundary

After spawning reviewers or sending rebuttal prompts, tell the user what was dispatched and end the current turn. Reviewer replies arrive through later Agent Deck messages. Do not sleep, busy-wait, or repeatedly poll sessions in the same turn.

Check progress only when the user asks or a reviewer has had no reply and no activity for at least 30 minutes. If activity is recent, report that it is still running. If stale, send one nudge on the current reply chain; use the failure path if it remains stale.

### Evidence And Adjudication

The lead classifies evidence; reviewers do not decide the outcome. Give each finding one status:

- `ACCEPTED`: independently reported by both reviewers, or reported by one and verified by a bounded lead-side check.
- `REBUTTED`: disproved by the other reviewer or lead-side evidence.
- `UNVERIFIED`: plausible but unsupported; keep it at MEDIUM or lower.

Track `Coverage: COMPLETE | INCOMPLETE` separately for each reviewer. Incomplete coverage is not evidence that the unreadable surface has no findings and cannot support a `NO_BLOCKING_EVIDENCE` recommendation.

CRITICAL and HIGH findings require a rebuttal record even when both reviewers found the issue. Record the supporting evidence, strongest rebuttal, and lead classification. For a single-reviewer MEDIUM, run a small search, read, command, or focused test when possible; otherwise mark it `UNVERIFIED` or lower its severity.

Severity follows impact and trigger likelihood:

| Severity | Meaning |
|---|---|
| CRITICAL | Stable data loss, permission bypass, secret disclosure, arbitrary code execution, severe cross-session mixup, or global core-path outage without a reliable workaround. |
| HIGH | Reproducible crash, deadlock, state corruption, security-boundary break, user work loss, core wrong result, or stable regression for a user class. |
| MEDIUM | Real limited-scope defect, missing key regression coverage, or prompt/plan defect that can cause a wrong action without breaking a hard safety boundary. |
| LOW | Small edge case, minor copy drift, or low-risk maintainability issue. |
| INFO | Context, caveat, coverage note, confirmed non-issue, or optional improvement. |

### Finding Contract

Require every finding to include:

- A stable `finding_id`, unique within the invocation, and preserved unchanged through rebuttal and reporting.
- `file:line` and a source snippet of at most 6 lines.
- A verification method: search evidence, focused test, command result, or precise reasoning check.
- Severity and a 1-2 line fix direction, not a full patch.
- For race, lifecycle, architecture, security, performance, or multi-step plan claims, a concrete trigger or state sequence and visible consequence.
- `Decision impact: routine | major`; the lead validates this classification rather than treating it as a reviewer decision.

Mark limited evidence as `*unverified*`. Downgrade or reject findings that lack a location, snippet, verification, fix direction, or concrete example for a complex claim.

### Reviewer Prompt Contract

Every independent-review prompt includes:

- A fresh `invocation_id`, `output_mode: full_review`, the selected reviewer pair, `review_type`, and a reviewer-specific `finding_id_prefix` such as `R1-CLAUDE`.
- Absolute scope paths, a required single-pass `focus`, and `baseline: commit:<hash> | working-tree`.
- The finding contract and the requirement to report `Coverage: COMPLETE | INCOMPLETE`, reviewed paths, and unreadable paths or restricted steps.

For a commit baseline, reviewers compare with `git diff <hash> -- <paths>`. For a working-tree baseline, they inspect both `git diff -- <paths>` and `git diff --cached -- <paths>` when diffs are relevant. Round 1 still requires reading every target file.

### Failure Handling

| Situation | Required action |
|---|---|
| Selected reviewer fails to start, loses auth, hits sandbox denial, times out, or loses thread state | Shut down that session and retry the same selected slot at most twice. If it still fails, ask the user to wait, continue with explicitly downgraded single-reviewer evidence, or abort. |
| Reviewer reports `⚠ FRESH SESSION` | Shut it down, respawn the same slot, and restart the review round with the full scope. |
| Reviewer reports `⚠ SCOPE PATH MISMATCH` | Correct the path list or cache manifest, then shut down and respawn the affected reviewer with the full prompt. |
| Cache staging fails | Abort before review and report the exact path and reason. |
| MCP send or spawn fails | Follow the tool error; do not silently change reviewer slots or adapters. |

## One-Pass Workflow

1. Normalize the scope, confirm the reviewer pair, prepare the cache if needed, and build a focused prompt for each reviewer.
2. Spawn the two reviewers concurrently. Save each `sessionId` and `spawnPromptMessageId`, announce the dispatch, and end the turn.
3. When both independent reviews arrive, verify that every finding has a unique stable id such as `R1-CLAUDE-001`, classify it, and assemble one rebuttal batch per reviewer. Include all CRITICAL/HIGH findings and any material disagreement; preserve each `finding_id` and ask each reviewer to challenge only the other reviewer's listed findings.
4. Send both rebuttal batches, save the returned reply-chain anchors, announce the dispatch, and end the turn.
5. When the rebuttals arrive, finalize evidence classifications. Do not apply fixes, start a second review round, or silently escalate.
6. Shut down both reviewer sessions, remove this invocation's cache directory, and present the result to the user.

Every rebuttal prompt retains the same `invocation_id`, reviewer pair, and absolute scope paths, uses `output_mode: rebuttal`, contains only challenged findings with their stable `finding_id` values, and requires one verdict per id: an independent `agree`, `disagree`, or `uncertain` judgment with evidence. Never accept one aggregate verdict for a multi-finding batch.

Use these focus areas as relevant:

- Code: correctness, regression risk, edge cases, concurrency/lifecycle/security/performance risk, and key regression coverage.
- Plan: decision and invariant clarity, internal consistency, current file/function references, executable handoff steps, and test coverage.
- Prompt: task-time action changes, preserved safety/tool/validation/failure gates, paired-asset alignment, and stale or contradictory instructions.
- Mixed: apply each relevant focus and verify that decisions are enforced by the implementation or prompt behavior.

## User Decision Report

Simple review does not issue a final merge or acceptance gate. Report:

- Scope and reviewed paths.
- Per-reviewer coverage, unreadable paths, and validation restrictions.
- Reviewer pair, session ids, retries, and whether heterogeneity stayed intact.
- Findings by severity and `ACCEPTED` / `REBUTTED` / `UNVERIFIED`, including CRITICAL/HIGH support and rebuttal evidence.
- A lead recommendation: `NO_BLOCKING_EVIDENCE`, `CHANGES_ADVISED`, `INCOMPLETE_REVIEW`, or `ESCALATE_TO_DEEP_REVIEW`. Use `INCOMPLETE_REVIEW` whenever either selected reviewer did not complete the required scope and focus.
- Explicit next choices for the user: accept, request fixes, or start `deep-review`.
- Reviewer shutdown and cache cleanup status.

End with `Final decision: USER_DECISION_REQUIRED`. The user owns the final judgment.
