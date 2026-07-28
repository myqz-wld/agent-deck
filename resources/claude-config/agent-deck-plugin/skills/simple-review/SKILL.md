---
name: simple-review
description: "Run exactly one independent adversarial review round followed by one bounded rebuttal round with two confirmed heterogeneous reviewer types, partitioning broad scopes into concurrent paired batches. Use for code, plan, prompt-asset, technical-decision, agent-validation, or overall-change checks, including 简单 review, 轻量 review, 帮我 review, 这个对不对, 对抗一下, 决策评审, and 整体改动是否符合预期. Present the evidence and recommendation to the user for final judgment; do not start a fix-and-re-review loop."
---

# Simple Review

Run one focused adversarial review and one rebuttal round, then return the final judgment to the user. Use `deep-review` when the work needs iterative fixes, repeated review rounds, or deep architecture, race, lifecycle, security, or performance investigation.

## Shared Review Protocol

### Scope And Authorization

Agent Deck MCP session tools must be available. If `spawn_session`, `send_message`, `get_session`, or `shutdown_session` is unavailable, stop and ask for an Agent Deck-enabled environment or a manual review.

Establish the scope from the user's request:

- Classify the review as code, plan, prompt, technical decision, or a small mixed scope. Ask only when the intent is materially ambiguous.
- Resolve the requested files or current change set, then place absolute paths in reviewer prompts.
- Keep one batch small enough for a single direct pass. When the full scope is too broad, partition it by subsystem or decision boundary and review the batches concurrently as capacity allows. Use `deep-review` instead when the work needs iterative depth or fixes.
- Keep strongly coupled files, producer-consumer contracts, and one end-to-end state transition in the same batch when practical. When two or more primary batches exist, add one integration batch containing the changed boundary files and cross-batch sequences that need explicit consistency review.
- Keep reviewed target artifacts unchanged. Review workers may run focused validations and isolated spikes, including commands that create caches or build output, but must not edit scoped source, the Git index, commits, or user changes. Disposable fixtures belong under `/tmp/agent-deck-review/<invocation_id>/<batch_id>/<reviewer>/`; workers report generated paths and clean them when practical. Adding the required `.review-cache/` ignore entry is the only lead-side review-infrastructure write.
- In a worktree, review the worktree copy rather than the base checkout.

### Batch Plan

Before spawning, create one batch manifest for the invocation. Each entry contains:

- A stable `batch_id`, unique within the invocation.
- `batch_kind: primary | integration`.
- Absolute `batch_scope` paths, one boundary or subsystem rationale, dependencies on other batches, and the common baseline.
- The focus for that batch. An integration batch focuses only on changed interfaces, shared invariants, and cross-batch state or data flow.

Every target path belongs to at least one primary batch. Intentional overlap is allowed and recorded in the manifest. Do not partition by arbitrary file count when it would separate a contract from its callers. A single small scope uses one primary batch and no integration batch.

### Reviewer Pair And Workers

Require exactly two user-confirmed, distinct reviewer types. If the user has not selected a pair, ask them to choose and stop before spawning.

| Reviewer | Spawn |
|---|---|
| `reviewer-claude` | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| `reviewer-codex` | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |
| `reviewer-grok` | `spawn_session({ adapter: 'grok-build', agentName: 'reviewer-grok', cwd, teamName, displayName, prompt })` |

Reject duplicate types and every selection that is not exactly two types. For every batch, spawn one worker session for each selected type, giving both workers the same batch scope and focus. Multiple batches may have separate sessions with the same `agentName`; label each with `displayName: '<reviewer> · <batch_id>'`. Record every worker session in the batch manifest and final report.

Do not pass permission, approval, or sandbox overrides unless the user explicitly requested the exact value. Omission is intentional: a same-adapter worker inherits the lead's persisted runtime, while a cross-adapter worker uses the target adapter's default. A `reviewer-*` `agentName` never grants or restricts runtime access. On respawn, repeat only overrides that came from the user's explicit request.

Keep every batch pair heterogeneous for the whole invocation. Never assign half a batch to each reviewer: both workers independently inspect the entire batch. If one worker fails, shut it down and respawn the same batch, adapter, provider, `agentName`, and model type; never substitute an unselected type or treat the surviving worker as complete coverage.

Use the `spawnLimits` returned by `spawn_session` to maintain a bounded concurrency window. Dispatch as many complete two-worker batch pairs as capacity permits and queue the remaining batches. Do not intentionally start a batch when only one worker slot is available. A partial spawn follows Failure Handling and does not change the selected pair.

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

- `ACCEPTED`: independently reported by both workers in the same batch, or reported by one and verified by a bounded lead-side check.
- `REBUTTED`: disproved by the other reviewer or lead-side evidence.
- `UNVERIFIED`: plausible but unsupported; keep it at MEDIUM or lower.

Track `Coverage: COMPLETE | INCOMPLETE` separately for each reviewer and batch. Invocation coverage is complete only when both workers completed every required primary and integration batch. Incomplete batch coverage is not evidence that the unreadable surface has no findings and cannot support a `NO_BLOCKING_EVIDENCE` recommendation.

CRITICAL and HIGH findings require a rebuttal record even when both workers in the batch found the issue. Record the supporting evidence, strongest rebuttal, and lead classification. For a single-worker MEDIUM, run a small search, read, command, or focused test when possible; otherwise mark it `UNVERIFIED` or lower its severity.

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

- A fresh `invocation_id`, stable `batch_id`, `batch_kind`, absolute `batch_scope`, `output_mode: full_review`, the selected reviewer pair, and `review_type`.
- A reviewer- and batch-specific `finding_id_prefix` such as `AUTH-R1-CLAUDE`, a required single-pass `focus`, and `baseline: commit:<hash> | working-tree`.
- The finding contract and the requirement to report `Coverage: COMPLETE | INCOMPLETE`, reviewed paths, and unreadable paths or restricted steps.
- The validation boundary: focused tests, builds, and isolated spikes are allowed; disposable artifacts go under that worker's `/tmp/agent-deck-review/...` directory, while scoped source, the Git index, commits, and user changes remain untouched.

For a commit baseline, reviewers compare with `git diff <hash> -- <paths>`. For a working-tree baseline, they inspect both `git diff -- <paths>` and `git diff --cached -- <paths>` when diffs are relevant. Round 1 still requires reading every target file.

### Failure Handling

| Situation | Required action |
|---|---|
| Selected batch worker fails to start, loses auth, hits sandbox denial, times out, or loses thread state | Let unrelated batches continue. Shut down that session and retry the same batch and selected type at most twice. If it still fails, mark that batch incomplete and ask the user to wait, continue with explicitly downgraded evidence, or abort. |
| Reviewer reports `⚠ FRESH SESSION` | Shut it down, respawn the same batch worker, and restart that batch with its full scope. |
| Reviewer reports `⚠ SCOPE PATH MISMATCH` | Correct the path list or cache manifest, then shut down and respawn the affected reviewer with the full prompt. |
| Cache staging fails | Abort before review and report the exact path and reason. |
| MCP send or spawn fails | Follow the tool error; do not silently change reviewer types or adapters. |

## One-Pass Workflow

1. Normalize the scope, confirm the reviewer pair, build the batch manifest, prepare the cache if needed, and create one focused prompt per batch worker.
2. Spawn complete batch pairs concurrently up to the available capacity. Save each worker's `sessionId` and `spawnPromptMessageId`, announce the dispatched and queued batches, and end the turn.
3. As complete batch pairs return, dispatch queued pairs into freed capacity on the next turn. Do not adjudicate the invocation as clean until every required batch has returned or failed explicitly.
4. Verify that every finding has a unique batch-qualified stable id such as `AUTH-R1-CLAUDE-001`, classify it within its batch, and deduplicate only after preserving the original ids. Assemble one rebuttal message per worker containing the other worker's challenged findings from the same batch. Include all CRITICAL/HIGH findings and material disagreements.
5. Send rebuttals concurrently within the bounded window, save the reply-chain anchors, announce the dispatch, and end the turn. An integration-batch finding may cite primary-batch evidence, but reviewers rebut only findings explicitly supplied by the lead.
6. When all rebuttals arrive, finalize per-batch classifications, then reconcile duplicates, contradictions, and integration findings across batches. Do not apply fixes, start a second review round, or silently escalate.
7. Shut down every worker session, remove this invocation's cache directory, and present one aggregated result to the user.

Every rebuttal prompt retains the same `invocation_id`, `batch_id`, `batch_kind`, reviewer pair, and absolute batch scope, uses `output_mode: rebuttal`, contains only challenged findings with their stable `finding_id` values, and requires one verdict per id: an independent `agree`, `disagree`, or `uncertain` judgment with evidence. Never accept one aggregate verdict for multiple findings.

Use these focus areas as relevant:

- Code: correctness, regression risk, edge cases, concurrency/lifecycle/security/performance risk, and key regression coverage.
- Plan: decision and invariant clarity, internal consistency, current file/function references, executable handoff steps, and test coverage.
- Prompt: task-time action changes, preserved safety/tool/validation/failure gates, paired-asset alignment, and stale or contradictory instructions.
- Mixed: apply each relevant focus and verify that decisions are enforced by the implementation or prompt behavior.

## User Decision Report

Simple review does not issue a final merge or acceptance gate. Report:

- Scope and reviewed paths.
- The batch manifest, including primary/integration rationale and queued waves.
- Per-reviewer, per-batch coverage, unreadable paths, and validation restrictions.
- Reviewer pair, worker session ids by batch, retries, and whether heterogeneity stayed intact.
- Findings by severity and `ACCEPTED` / `REBUTTED` / `UNVERIFIED`, including CRITICAL/HIGH support and rebuttal evidence.
- A lead recommendation: `NO_BLOCKING_EVIDENCE`, `CHANGES_ADVISED`, `INCOMPLETE_REVIEW`, or `ESCALATE_TO_DEEP_REVIEW`. Use `INCOMPLETE_REVIEW` whenever either selected reviewer did not complete any required batch scope and focus.
- Explicit next choices for the user: accept, request fixes, or start `deep-review`.
- Reviewer shutdown and cache cleanup status.

End with `Final decision: USER_DECISION_REQUIRED`. The user owns the final judgment.
