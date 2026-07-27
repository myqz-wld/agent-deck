---
name: deep-review
description: "Run iterative heterogeneous review rounds for complex code, plans, or mixed changes with two confirmed reviewer types, partitioning broad scopes into concurrent paired batches. Use for deep race, lifecycle, architecture, security, performance, plan-gate, or design-to-code risk, including 深度 review, 双对抗 review, review agent 深挖, 再 review 一轮, 深挖整体改动是否符合预期, and plan 评审. Continue routine in-scope review/fix rounds autonomously; ask the user to review only when a proposed remedy requires an architecture-level or similarly major decision."
---

# Deep Review

Run a multi-round `review -> adjudicate -> fix when authorized -> review` loop until the selected reviewers stop finding material issues or the workflow is blocked. Use later rounds to pressure-test edge cases, races, lifecycle leaks, plan invariants, architecture coupling, security, performance, and test gaps.

## Shared Review Protocol

### Scope And Authorization

Agent Deck MCP session tools must be available. If `spawn_session`, `send_message`, `get_session`, or `shutdown_session` is unavailable, stop and ask for an Agent Deck-enabled environment or a manual review.

Establish the scope from the user's request:

- Classify the review as code, plan, or mixed. Ask only when the intent is materially ambiguous.
- Resolve the requested files or current change set, then place absolute paths in reviewer prompts.
- Keep each batch directly inspectable. Split broad scopes by subsystem or decision boundary and review independent batches concurrently as capacity allows.
- Keep strongly coupled files, producer-consumer contracts, and one end-to-end state transition in the same primary batch when practical. When two or more primary batches exist, add one integration batch for changed interfaces, shared invariants, and cross-batch state or data flow.
- Keep reviewed artifacts read-only except for the required `.review-cache/` ignore entry. Apply target fixes only when the user requested review-and-fix or the surrounding implementation task already grants write authority.
- In a worktree, review and edit the worktree copy rather than the base checkout.

### Batch Plan

Before spawning, create one invocation-level batch manifest. Each entry contains:

- A stable `batch_id`, unique within the invocation, and `batch_kind: primary | integration`.
- Absolute `batch_scope` paths, the subsystem or decision boundary, dependencies on other batches, the baseline, and the current-round focus.
- A state of `queued | active | reviewed | rebutting | complete | incomplete`.

Every target path belongs to at least one primary batch. Record intentional overlap and keep the integration batch focused on boundary paths and concrete cross-batch sequences rather than rereading the entire change without a focus. Preserve stable batch ids across rounds. Split or merge a batch later only when fixes materially change its boundary; record the replacement mapping and rerun every affected batch.

### Reviewer Pair And Workers

Require exactly two user-confirmed, distinct reviewer types. If the user has not selected a pair, ask them to choose and stop before spawning.

| Reviewer | Spawn |
|---|---|
| `reviewer-claude` | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| `reviewer-codex` | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |
| `reviewer-grok` | `spawn_session({ adapter: 'grok-build', agentName: 'reviewer-grok', cwd, teamName, displayName, prompt })` |

Reject duplicate types and every selection that is not exactly two types. For every active batch, spawn one worker session for each selected type, giving both workers the same batch scope and focus. Multiple batches may use separate sessions with the same `agentName`; label each with `displayName: '<reviewer> · <batch_id>'`. Record every worker session in the batch manifest and final report. Do not pass permission or sandbox overrides unless the user requested them.

Keep every batch pair heterogeneous for the whole invocation. Never shard a batch between the pair: both workers independently inspect the full batch. Reuse the same two worker sessions for that batch across rounds. If one worker fails, shut it down and respawn the same batch, adapter, provider, `agentName`, and model type; never substitute an unselected type or treat the surviving worker as complete coverage.

Use the `spawnLimits` returned by `spawn_session` to maintain a bounded concurrency window. Dispatch as many complete two-worker batch pairs as capacity permits and queue the rest. Do not intentionally start a batch when only one worker slot is available. A partial spawn follows Failure Handling and does not change the selected pair.

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

After spawning reviewers or sending rebuttal or next-round prompts, tell the user what was dispatched and end the current turn. Reviewer replies arrive through later Agent Deck messages. Do not sleep, busy-wait, or repeatedly poll sessions in the same turn.

Check progress only when the user asks or a reviewer has had no reply and no activity for at least 30 minutes. If activity is recent, report that it is still running. If stale, send one nudge on the current reply chain; use the failure path if it remains stale.

### Evidence And Adjudication

The lead classifies evidence; reviewers do not decide the outcome. Give each finding one status:

- `ACCEPTED`: independently reported by both workers in the same batch, or reported by one and verified by a bounded lead-side check.
- `REBUTTED`: disproved by the other reviewer or lead-side evidence.
- `UNVERIFIED`: plausible but unsupported; keep it at MEDIUM or lower.

Track `Coverage: COMPLETE | INCOMPLETE` separately for each reviewer, batch, and round. Incomplete coverage is not evidence that the unreadable surface has no findings. A batch cannot converge until both workers complete its required scope and focus, and the invocation cannot converge until every required primary and integration batch does so or reports a blocker.

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

- A stable `finding_id`, unique within the invocation, and preserved unchanged through rebuttal, fixes, later rounds, and reporting.
- `file:line` and a source snippet of at most 6 lines.
- A verification method: search evidence, focused test, command result, or precise reasoning check.
- Severity and a 1-2 line fix direction, not a full patch.
- For race, lifecycle, architecture, security, performance, or multi-step plan claims, a concrete trigger or state sequence and visible consequence.
- `Decision impact: routine | major`; the lead validates this signal against the User Review Boundary rather than treating it as a reviewer decision.

Mark limited evidence as `*unverified*`. Downgrade or reject findings that lack a location, snippet, verification, fix direction, or concrete example for a complex claim.

### Failure Handling

| Situation | Required action |
|---|---|
| Selected batch worker fails to start, loses auth, hits sandbox denial, times out, or loses thread state | Let unrelated batches continue. Shut down that session and retry the same batch and selected type at most twice. If it still fails, mark that batch incomplete and ask the user to wait, continue with explicitly downgraded evidence, or abort. |
| Reviewer reports `⚠ FRESH SESSION` | Shut it down, respawn the same batch worker, and restart that batch's current round with its full scope. |
| Reviewer reports `⚠ SCOPE PATH MISMATCH` | Correct the path list or cache manifest, then shut down and respawn the affected reviewer with the full prompt. |
| Cache staging fails | Abort before review and report the exact path and reason. |
| MCP send or spawn fails | Follow the tool error; do not silently change reviewer types or adapters. |

## Round Strategy

Use the same worker pair for each batch in every round. Different batches may advance concurrently, but do not advance one batch past a fix that changes another batch's boundary; mark both affected batches and the integration batch for re-review. Send only the current round's focus plus relevant changed paths and accepted-fix summaries.

| Round | Code | Plan | Mixed |
|---|---|---|---|
| 1 | Correctness, regressions, key tests | Workflow consistency, decision clarity, checklist completeness | Apply both round-1 focuses and check design-to-code consistency |
| 2 | Edge cases, races, resource lifecycle | Invariant boundaries, current line/function references, test matrix | Apply both round-2 focuses and check invariant enforcement |
| 3 | Architecture coupling, security, tail performance | Phase drift, conflicting triggers, missing fallback paths | Apply both round-3 focuses and check architecture alignment |
| 4+ | Residual findings and newly changed surfaces | Residual findings and newly changed decisions | Residuals across both artifacts |

Every reviewer prompt includes:

- A fresh `invocation_id` that remains stable for all rounds.
- A stable `batch_id`, `batch_kind`, absolute `batch_scope`, and batch dependencies.
- `output_mode: full_review` or `output_mode: rebuttal`.
- The selected pair and exact adapter, `agentName`, and model when specified.
- The `review_type`.
- A reviewer-, batch-, and round-specific `finding_id_prefix`, such as `AUTH-R2-CODEX`.
- Absolute batch scope paths, using staged cache paths for external files.
- Only the current round's focus.
- The finding contract.
- `baseline: commit:<hash> | working-tree`. For a commit baseline, reviewers use `git diff <hash> -- <paths>`; for a working-tree baseline, they inspect both `git diff -- <paths>` and `git diff --cached -- <paths>`.
- A `skip` list for accepted stable items and fixes, formatted as `fixed: <file:line> <change> (baseline commit:<hash> | working-tree)`.
- The requirement to report `Coverage: COMPLETE | INCOMPLETE`, reviewed paths, and unreadable paths or restricted steps.

Round 1 requires each worker to read every target file in its batch. For Round 2+, choose the baseline that identifies the prior accepted state, send the relevant changed paths and validation evidence, and keep stable finding ids for carried findings.

## Multi-Round Workflow

1. Normalize the scope, confirm the reviewer pair, build the batch manifest, prepare the cache if needed, and create round 1 prompts for every batch worker.
2. Spawn complete batch pairs concurrently up to capacity. Save each worker's `sessionId` and `spawnPromptMessageId`, announce active and queued batches, and end the turn.
3. As complete pairs return, dispatch queued pairs into freed capacity on the next turn. For each reviewed batch, verify unique ids such as `AUTH-R2-CODEX-001`, classify findings, and send every CRITICAL/HIGH finding to the other worker from the same batch for rebuttal. Batch rebuttal messages per recipient and require one verdict per id.
4. Finalize per-batch classifications after rebuttal, then reconcile duplicates, contradictions, and integration findings across batches. Give every MEDIUM a disposition: fix now, accept risk, or follow-up.
5. In review-and-fix scope, apply localized, reversible, in-scope fixes and run focused validation. Mark every directly changed batch plus any dependent and integration batch for re-review. In review-only scope, preserve the working tree and carry accepted findings into the next round.
6. Send the next-round focus, baseline, changed paths, validation evidence, and `skip` list to the existing worker pair for each affected batch. Advance independent batches concurrently within the capacity window, announce each dispatch, and end the turn.
7. Repeat adjudication, authorized fixes, validation, and per-batch review until all batches converge, an unresolved blocker remains, or a major-decision boundary requires the user. After the last boundary-affecting fix, the integration batch must complete one final pass.
8. Shut down every worker session, remove this invocation's cache directory, and deliver one aggregated report.

Do not shut down batch workers between rounds. Reuse each worker only for its original batch unless a recorded split or merge replaces that batch. If the next round may happen much later, leave sessions active or dormant and resume them with `send_message`.

## User Review Boundary

Continue routine rounds without asking the user to approve every finding, localized fix, test addition, or round transition when those actions are already authorized and stay within the requested design.

Pause and ask the user to review before applying a remedy that would materially change any of these:

- Architecture, subsystem ownership, or core abstraction boundaries.
- Public API, protocol, persistence model, migration strategy, or security boundary.
- User-visible behavior or compatibility outside the confirmed request.
- Destructive behavior, data handling, or a major dependency/tooling choice.
- Scope, timeline, or risk tradeoffs where multiple materially different designs remain viable.

Present the finding, evidence, rebuttal, viable options, and expected downstream impact. Resume the same review round after the user decides. Do not request intermediate user review for routine in-scope remediation.

Treat reviewer `Decision impact` as an input to this boundary, not as authority. The lead must explain why the remedy is routine or major before continuing or pausing.

## Gate And Final Report

Pass only when both workers report `Coverage: COMPLETE` for every required batch's latest applicable round, the final integration pass is complete when batching was used, no CRITICAL/HIGH remains unresolved, authorized CRITICAL/HIGH fixes have focused validation, and every MEDIUM has a disposition. Block when any required batch coverage remains incomplete, a CRITICAL/HIGH remains, workers keep finding substantial new issues without convergence, required write authority is absent, or the user declines a necessary major change.

Report:

- Scope, review type, reviewed paths, and number of rounds.
- The batch manifest, dependencies, concurrency waves, and split/merge history.
- Per-reviewer, per-batch, per-round coverage, unreadable paths, and validation restrictions.
- Final gate: `PASS`, `BLOCKED`, `ABORTED`, or `ESCALATED_TO_USER`.
- Reviewer pair, worker session ids by batch, retries, and whether heterogeneity stayed intact.
- Findings by severity and `ACCEPTED` / `REBUTTED` / `UNVERIFIED`, including CRITICAL/HIGH support and rebuttal evidence.
- Fix and decision log, validation commands, MEDIUM dispositions, accepted risks, and follow-ups.
- Any user-reviewed major decision and its downstream consequence.
- Reviewer shutdown and cache cleanup status.

Do not finish with only "done" or "review passed".

## Relation To Simple Review

Use `simple-review` for exactly one independent review round plus one rebuttal round, followed by user judgment. Use `deep-review` for iterative depth and autonomous in-scope remediation, involving the user mid-process only at the major-decision boundary above.
