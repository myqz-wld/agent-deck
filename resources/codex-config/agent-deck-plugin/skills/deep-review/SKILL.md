---
name: deep-review
description: "Run severity-driven paired review, rebuttal, authorized fixes, and targeted re-review with two confirmed heterogeneous reviewer types. Use for deep race, lifecycle, architecture, security, performance, plan-gate, or design-to-code risk, including 深度 review, 双对抗 review, review agent 深挖, 再 review 一轮, 深挖整体改动是否符合预期, and plan 评审."
---

# Deep Review

## Role

This skill is the coordinator and adjudicator, not a third artifact reviewer. The lead owns scope, pair confirmation, batching, dispatch, contract checks, evidence classification, fix authority, round eligibility, convergence, user-decision boundaries, and the final gate. Reviewer agents own independent artifact inspection, normal-path finding admission, plan/code judgment, evidence, and rebuttal verdicts; they do not manage the lifecycle, apply fixes, or decide convergence.

Use severity-driven depth: investigate or re-review only material evidence. Apply fixes only when the user requested review-and-fix or the surrounding implementation task already grants write authority.

## Setup

Agent Deck `spawn_session`, `send_message`, `get_session`, and `shutdown_session` must be available. Otherwise stop and request an Agent Deck-enabled environment or a manual review.

1. Resolve the review type, baseline, absolute paths, deep-risk focus, and worktree. Ask only when ambiguity would materially change the review.
2. Require exactly two user-confirmed, distinct reviewer types:

   | Reviewer | Spawn target |
   |---|---|
   | `reviewer-claude` | `adapter: 'claude-code', agentName: 'reviewer-claude'` |
   | `reviewer-codex` | `adapter: 'codex-cli', agentName: 'reviewer-codex'` |
   | `reviewer-grok` | `adapter: 'grok-build', agentName: 'reviewer-grok'` |

   Reject every other selection. Do not pass permission, approval, or sandbox overrides unless the user explicitly requested the exact value. A same-adapter worker inherits the persisted lead runtime; a cross-adapter worker uses the target adapter default. A `reviewer-*` `agentName` never grants or restricts runtime access.
3. Build a manifest of stable `batch_id` entries with `batch_kind: primary | integration`, absolute `batch_scope`, boundary rationale, dependencies, baseline, focus, and state. Keep coupled contracts and end-to-end transitions together. Every target belongs to a primary batch; when two or more primary batches exist, add an integration batch for changed interfaces, invariants, and cross-batch flow.
4. Give both workers in every batch the same complete scope and focus. Label sessions with `displayName: '<reviewer> · <batch_id>'`. Use returned `spawnLimits` to dispatch only complete two-worker pairs; queue the rest. Reuse each batch's pair across rounds. Never split one batch between reviewers or count one worker as complete coverage.
5. Reviewers must leave scoped source, the Git index, commits, and user changes untouched. Focused tests, builds, and isolated spikes are allowed. Disposable artifacts belong under `/tmp/agent-deck-review/<invocation_id>/<batch_id>/<reviewer>/`. The lead edits only the active worktree under existing authority.

When an absolute scoped file is outside reviewer `cwd`, stage it under `<reviewRoot>/.review-cache/<invocationId>/`. First require the exact `.review-cache/` entry in `<reviewRoot>/.gitignore`; then use collision-safe names and a `manifest.json` mapping original to staged paths. Remove only invocation directories whose manifest is older than 24 hours, plus this invocation's directory on completion. Stop and report the exact path if staging, ignore setup, or cleanup fails.

## Evidence

Track `Coverage: COMPLETE | INCOMPLETE` per reviewer, batch, and pass. A batch can converge only after both workers complete its latest eligible focus. Unreadable scope is incomplete coverage, never a clean result.

Classify each stable `finding_id` as:

- `ACCEPTED`: both workers found it, or one found it and a bounded lead check verified it.
- `REBUTTED`: counter-evidence disproved it.
- `UNVERIFIED`: plausible but unsupported; keep it at MEDIUM or lower.

Admit only findings reproducible in a supported, normal environment or operation, or for plans, under an evidence-backed nearby evolution. Security findings may use adversarial input when that input crosses a real trust boundary. Reject unsupported configurations, deliberate misuse, unreachable states outside a trust boundary, requirement-free pathological scale, aesthetic preference, and speculative future needs.

Each finding must include `file:line`, a snippet of at most six lines, verification, a normal-path trigger or premise and visible consequence/current cost, severity, concise fix direction, and `Decision impact: routine | major`. Complex race, lifecycle, architecture, security, performance, or plan claims also require a concrete state sequence. Missing or limited evidence is `*unverified*` and MEDIUM or lower. An empty admissible finding set is valid.

Severity controls depth:

- CRITICAL/HIGH always receive rebuttal. If unresolved or materially fixed, they require targeted follow-up.
- For MEDIUM, the lead judges materiality from impact and likelihood in a supported normal scenario. Continue only when more evidence or remediation could materially change correctness, user outcome, a core invariant, an architecture decision, or the final gate. Otherwise record `fix opportunistically`, `accept risk`, or `follow-up` and stop deepening it.
- LOW/INFO may be fixed opportunistically when obvious, localized, authorized, and followed by focused lead-side validation. They never trigger rebuttal, adjacent investigation, a new pass, or keep a batch open. If an eligible pass already exists, the incidental edit may be included without extending that pass.

The lead validates contract compliance and materiality; it does not invent findings to fill reviewer coverage gaps.

## Lifecycle

Use only these passes:

| Pass | Eligibility | Focus |
|---|---|---|
| Initial | Always | Complete batch, requested review type, and user-named deep risks. |
| Evidence follow-up | Unresolved CRITICAL/HIGH or material MEDIUM | Reproduce, rebut, or narrow the finding and directly adjacent risk. |
| Post-fix | An eligible finding caused a material fix | Changed paths, dependent contracts, validation, and integration boundary. |
| Residual | Material evidence remains or a material fix exposes another material issue | Residual evidence and newly affected surfaces only. |

LOW/INFO alone never make a pass eligible. A clean initial pass needs no ceremonial second pass.

1. Create one `invocation_id` for all passes. Every worker prompt includes stable batch fields, dependencies, selected pair, `review_type`, current focus and eligibility basis, `finding_id_prefix` containing batch and pass, `output_mode: full_review | rebuttal`, `baseline: commit:<hash> | working-tree`, and a `skip` list of accepted stable items. Require the initial pass to read every target. For diffs, use `git diff <hash> -- <paths>` or both `git diff -- <paths>` and `git diff --cached -- <paths>`.
2. Spawn complete batch pairs up to capacity. Save each `sessionId` and non-null `spawnPromptMessageId`; when the latter is null, establish a reply anchor with `send_message`. Announce active and queued batches, then end the turn.
3. On later turns, dispatch queued pairs as capacity opens. Validate ids and coverage, classify findings, and reconcile duplicates, contradictions, and integration evidence.
4. Send every CRITICAL/HIGH and recommendation-changing MEDIUM disagreement to the paired reviewer sessions in `rebuttal` mode. Require one `agree | disagree | uncertain` verdict per id and no unrelated findings. Batch messages per recipient, announce dispatch, and end the turn. LOW/INFO never enter rebuttal.
5. Give every MEDIUM an explicit materiality judgment and disposition. Under write authority, apply localized in-scope fixes and run focused validation. A material fix marks directly changed, dependent, and integration batches for re-review; an opportunistic LOW/INFO fix never changes eligibility.
6. Send eligible next-pass prompts to the same batch workers with the new baseline, changed paths, validation evidence, focus, and skip list. Independent batches may advance concurrently, but a boundary-changing fix reopens every affected batch. Announce dispatch and end the turn.
7. Repeat only while an eligibility condition remains. After the last material boundary-affecting fix, require one final integration pass. Then shut down workers, remove this invocation's cache, and report.

After any spawn or message whose useful next step depends on a reviewer reply, return control instead of polling. Check status only when the user asks or a worker has no reply and no activity for at least 30 minutes; send at most one nudge before using failure handling.

Continue routine authorized fixes, tests, and pass transitions without user approval. Pause before a remedy that materially changes architecture or ownership, core abstractions, public API/protocol, persistence or migration, security boundaries, user-visible compatibility, destructive/data behavior, a major dependency, or a scope/risk tradeoff with materially different viable designs. Present evidence, rebuttal, options, and downstream impact; reviewer `Decision impact` is input, not authority.

## Failure

- For start, auth, sandbox, timeout, or thread-state failure: shut down the worker and retry the same batch, adapter, provider/runtime selector, `agentName`, and model type at most twice. Never substitute an unselected reviewer. If it still fails, mark the batch incomplete and ask the user whether to wait, continue with explicitly downgraded evidence, or abort.
- On `⚠ FRESH SESSION`, shut down and respawn that worker, then restart the batch's current pass with its full prompt.
- On `⚠ SCOPE PATH MISMATCH`, correct paths or the cache manifest, then shut down, respawn, and resend the full prompt.
- Follow MCP errors as returned. A failed spawn or send never changes the confirmed pair.

## Report

Pass only when both workers complete every batch's latest eligible focus, the final integration pass follows the last material boundary change, no CRITICAL/HIGH remains, eligible fixes have focused validation, and every MEDIUM has a disposition. LOW/INFO never block or require another pass. Otherwise return `BLOCKED`, `ABORTED`, or `ESCALATED_TO_USER` as appropriate.

Report scope and pass count; batch/dependency history; pair, worker ids, retries, coverage, and restrictions; findings with status and rebuttal; fixes and validation; MEDIUM decisions; opportunistic LOW/INFO fixes; accepted risks and follow-ups; major user decisions; and worker shutdown/cache cleanup.
