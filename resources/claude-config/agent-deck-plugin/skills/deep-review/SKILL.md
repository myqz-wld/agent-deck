---
name: deep-review
description: "Run iterative heterogeneous review rounds for complex code, plans, or mixed changes with two confirmed reviewer slots. Use for deep race, lifecycle, architecture, security, performance, plan-gate, or design-to-code risk, including 深度 review, 双对抗 review, review agent 深挖, 再 review 一轮, 深挖整体改动是否符合预期, and plan 评审. Continue routine in-scope review/fix rounds autonomously; ask the user to review only when a proposed remedy requires an architecture-level or similarly major decision."
---

# Deep Review

Run a multi-round `review -> adjudicate -> fix when authorized -> review` loop until the selected reviewers stop finding material issues or the workflow is blocked. Use later rounds to pressure-test edge cases, races, lifecycle leaks, plan invariants, architecture coupling, security, performance, and test gaps.

## Shared Review Protocol

### Scope And Authorization

Agent Deck MCP session tools must be available. If `spawn_session`, `send_message`, `get_session`, or `shutdown_session` is unavailable, stop and ask for an Agent Deck-enabled environment or a manual review.

Establish the scope from the user's request:

- Classify the review as code, plan, or mixed. Ask only when the intent is materially ambiguous.
- Resolve the requested files or current change set, then place absolute paths in reviewer prompts.
- Keep each batch directly inspectable; split very broad scopes by subsystem or decision boundary.
- Keep reviewed artifacts read-only except for the required `.review-cache/` ignore entry. Apply target fixes only when the user requested review-and-fix or the surrounding implementation task already grants write authority.
- In a worktree, review and edit the worktree copy rather than the base checkout.

### Reviewer Pair

Require exactly two user-confirmed, distinct reviewer slots. If the user has not selected a pair, ask them to choose and stop before spawning.

| Reviewer | Spawn |
|---|---|
| `reviewer-claude` | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| `reviewer-codex` | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |
| `reviewer-deepseek` | `spawn_session({ adapter: 'deepseek-claude-code', agentName: 'reviewer-deepseek', model: 'deepseek-v4-pro[1m]', cwd, teamName, displayName, prompt })` |
| `reviewer-grok` | `spawn_session({ adapter: 'grok-build', agentName: 'reviewer-grok', cwd, teamName, displayName, prompt })` |

Reject duplicate slots and every selection that is not exactly two slots. Spawn only the selected pair, concurrently. Record the pair in reviewer prompts and the final report. Do not pass permission or sandbox overrides unless the user requested them.

Keep the pair heterogeneous for the whole invocation. If one selected reviewer fails, shut it down and respawn the same adapter, `agentName`, and model slot; never substitute an unselected slot or duplicate the survivor.

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

- `ACCEPTED`: independently reported by both reviewers, or reported by one and verified by a bounded lead-side check.
- `REBUTTED`: disproved by the other reviewer or lead-side evidence.
- `UNVERIFIED`: plausible but unsupported; keep it at MEDIUM or lower.

Track `Coverage: COMPLETE | INCOMPLETE` separately for each reviewer and round. Incomplete coverage is not evidence that the unreadable surface has no findings; a round cannot converge until both reviewers complete the required scope and focus or the workflow reports a blocker.

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
| Selected reviewer fails to start, loses auth, hits sandbox denial, times out, or loses thread state | Shut down that session and retry the same selected slot at most twice. If it still fails, ask the user to wait, continue with explicitly downgraded single-reviewer evidence, or abort. |
| Reviewer reports `⚠ FRESH SESSION` | Shut it down, respawn the same slot, and restart the current round with the full scope. |
| Reviewer reports `⚠ SCOPE PATH MISMATCH` | Correct the path list or cache manifest, then shut down and respawn the affected reviewer with the full prompt. |
| Cache staging fails | Abort before review and report the exact path and reason. |
| MCP send or spawn fails | Follow the tool error; do not silently change reviewer slots or adapters. |

## Round Strategy

Use the same reviewer sessions and pair in every round. Send only the current round's focus plus relevant changed paths and accepted-fix summaries; do not resend a large menu of every possible focus.

| Round | Code | Plan | Mixed |
|---|---|---|---|
| 1 | Correctness, regressions, key tests | Workflow consistency, decision clarity, checklist completeness | Apply both round-1 focuses and check design-to-code consistency |
| 2 | Edge cases, races, resource lifecycle | Invariant boundaries, current line/function references, test matrix | Apply both round-2 focuses and check invariant enforcement |
| 3 | Architecture coupling, security, tail performance | Phase drift, conflicting triggers, missing fallback paths | Apply both round-3 focuses and check architecture alignment |
| 4+ | Residual findings and newly changed surfaces | Residual findings and newly changed decisions | Residuals across both artifacts |

Every reviewer prompt includes:

- A fresh `invocation_id` that remains stable for all rounds.
- `output_mode: full_review` or `output_mode: rebuttal`.
- The selected pair and exact adapter, `agentName`, and model when specified.
- The `review_type`.
- A reviewer- and round-specific `finding_id_prefix`, such as `R2-CODEX`.
- Absolute scope paths, using staged cache paths for external files.
- Only the current round's focus.
- The finding contract.
- `baseline: commit:<hash> | working-tree`. For a commit baseline, reviewers use `git diff <hash> -- <paths>`; for a working-tree baseline, they inspect both `git diff -- <paths>` and `git diff --cached -- <paths>`.
- A `skip` list for accepted stable items and fixes, formatted as `fixed: <file:line> <change> (baseline commit:<hash> | working-tree)`.
- The requirement to report `Coverage: COMPLETE | INCOMPLETE`, reviewed paths, and unreadable paths or restricted steps.

Round 1 still requires reading every target file. For Round 2+, choose the baseline that identifies the prior accepted state, send the relevant changed paths and validation evidence, and keep the stable finding ids for carried findings.

## Multi-Round Workflow

1. Normalize the scope, confirm the reviewer pair, prepare the cache if needed, and build round 1 prompts.
2. Spawn the two reviewers concurrently. Save each `sessionId` and `spawnPromptMessageId`, announce the dispatch, and end the turn.
3. When both replies arrive, verify that every finding has a unique stable id such as `R2-CODEX-001` and classify it. Send the full text of each CRITICAL/HIGH finding to the other reviewer for rebuttal; preserve each `finding_id`, batch findings per recipient, require one verdict per id, announce the dispatch, and end the turn.
4. Finalize classifications after rebuttal. Give every MEDIUM a disposition: fix now, accept risk, or follow-up.
5. In review-and-fix scope, apply localized, reversible, in-scope fixes and run focused validation. In review-only scope, preserve the working tree and carry accepted findings into the next round.
6. Send the next-round focus, baseline, changed paths, validation evidence, and `skip` list to the same reviewer sessions. Announce the dispatch and end the turn.
7. Repeat adjudication, authorized fixes, validation, and review until both reviewers find no new material issue, an unresolved blocker remains, or a major-decision boundary requires the user.
8. Shut down both reviewer sessions, remove this invocation's cache directory, and deliver the final report.

Do not shut down reviewers between rounds. Reuse their context unless a failure path requires a same-slot respawn. If the next round may happen much later, leave the sessions active or dormant and resume them with `send_message`.

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

Pass only when both reviewers report `Coverage: COMPLETE` for the final round, no CRITICAL/HIGH remains unresolved, authorized CRITICAL/HIGH fixes have focused validation, and every MEDIUM has a disposition. Block when coverage remains incomplete, a CRITICAL/HIGH remains, reviewers keep finding substantial new issues without convergence, required write authority is absent, or the user declines a necessary major change.

Report:

- Scope, review type, reviewed paths, and number of rounds.
- Per-reviewer, per-round coverage, unreadable paths, and validation restrictions.
- Final gate: `PASS`, `BLOCKED`, `ABORTED`, or `ESCALATED_TO_USER`.
- Reviewer pair, session ids, retries, and whether heterogeneity stayed intact.
- Findings by severity and `ACCEPTED` / `REBUTTED` / `UNVERIFIED`, including CRITICAL/HIGH support and rebuttal evidence.
- Fix and decision log, validation commands, MEDIUM dispositions, accepted risks, and follow-ups.
- Any user-reviewed major decision and its downstream consequence.
- Reviewer shutdown and cache cleanup status.

Do not finish with only "done" or "review passed".

## Relation To Simple Review

Use `simple-review` for exactly one independent review round plus one rebuttal round, followed by user judgment. Use `deep-review` for iterative depth and autonomous in-scope remediation, involving the user mid-process only at the major-decision boundary above.
