---
name: simple-review
description: "Run one independent paired review and, only for CRITICAL/HIGH or recommendation-changing MEDIUM evidence, one bounded rebuttal. Use for code, plan, prompt, decision, agent-validation, or overall-change checks, including 简单 review, 轻量 review, 帮我 review, 这个对不对, 对抗一下, 决策评审, and 整体改动是否符合预期."
---

# Simple Review

## Role

This skill is the coordinator and adjudicator, not a third artifact reviewer. The lead owns scope, pair confirmation, batching, dispatch, contract checks, evidence classification, rebuttal eligibility, and the user report. Reviewer agents own independent artifact inspection, normal-path finding admission, plan/code/prompt judgment, evidence, and rebuttal verdicts; they do not manage the lifecycle, apply fixes, or decide the outcome.

Run exactly one independent review pass plus at most one material-finding rebuttal pass. Do not start a fix-and-re-review loop. Use `deep-review` when accepted material evidence needs iterative remediation or repeated investigation.

## Setup

Agent Deck `spawn_session`, `send_message`, `get_session`, and `shutdown_session` must be available. Otherwise stop and request an Agent Deck-enabled environment or a manual review.

1. Resolve the review type, baseline, absolute paths, and worktree from the user's request. Ask only when ambiguity would materially change the review.
2. Require exactly two user-confirmed, distinct reviewer types:

   | Reviewer | Spawn target |
   |---|---|
   | `reviewer-claude` | `adapter: 'claude-code', agentName: 'reviewer-claude'` |
   | `reviewer-codex` | `adapter: 'codex-cli', agentName: 'reviewer-codex'` |
   | `reviewer-grok` | `adapter: 'grok-build', agentName: 'reviewer-grok'` |

   Reject every other selection. Do not pass permission, approval, or sandbox overrides unless the user explicitly requested the exact value. A same-adapter worker inherits the persisted lead runtime; a cross-adapter worker uses the target adapter default. A `reviewer-*` `agentName` never grants or restricts runtime access.
3. Build a manifest of stable `batch_id` entries with `batch_kind: primary | integration`, absolute `batch_scope`, boundary rationale, dependencies, baseline, and focus. Keep coupled contracts and end-to-end transitions together. Every target belongs to a primary batch; when two or more primary batches exist, add an integration batch for changed interfaces, invariants, and cross-batch flow.
4. Give both workers in every batch the same complete scope and focus. Label sessions with `displayName: '<reviewer> · <batch_id>'`. Use returned `spawnLimits` to dispatch only complete two-worker pairs; queue the rest. Never split one batch between reviewers or count one worker as complete coverage.
5. Reviewers must leave scoped source, the Git index, commits, and user changes untouched. Focused tests, builds, and isolated spikes are allowed. Disposable artifacts belong under `/tmp/agent-deck-review/<invocation_id>/<batch_id>/<reviewer>/`.

When an absolute scoped file is outside reviewer `cwd`, stage it under `<reviewRoot>/.review-cache/<invocationId>/`. First require the exact `.review-cache/` entry in `<reviewRoot>/.gitignore`; then use collision-safe names and a `manifest.json` mapping original to staged paths. Remove only invocation directories whose manifest is older than 24 hours, plus this invocation's directory on completion. Stop and report the exact path if staging, ignore setup, or cleanup fails.

## Evidence

Track `Coverage: COMPLETE | INCOMPLETE` per reviewer and batch. Invocation coverage is complete only when both workers complete every required primary and integration batch. Unreadable scope is incomplete coverage, never a clean result.

Classify each stable `finding_id` as:

- `ACCEPTED`: both workers found it, or one found it and a bounded lead check verified it.
- `REBUTTED`: counter-evidence disproved it.
- `UNVERIFIED`: plausible but unsupported; keep it at MEDIUM or lower.

Admit only findings reproducible in a supported, normal environment or operation, or for plans, under an evidence-backed nearby evolution. Security findings may use adversarial input when that input crosses a real trust boundary. Reject unsupported configurations, deliberate misuse, unreachable states outside a trust boundary, requirement-free pathological scale, aesthetic preference, and speculative future needs.

Each finding must include `file:line`, a snippet of at most six lines, verification, a normal-path trigger or premise and visible consequence/current cost, severity, concise fix direction, and `Decision impact: routine | major`. Complex race, lifecycle, architecture, security, performance, or plan claims also require a concrete state sequence. Missing or limited evidence is `*unverified*` and MEDIUM or lower. An empty admissible finding set is valid.

Severity controls depth:

- CRITICAL/HIGH always receive a rebuttal record and may justify `ESCALATE_TO_DEEP_REVIEW`.
- MEDIUM receives rebuttal or escalation only when impact and normal-scenario likelihood make further evidence or remediation capable of changing the recommendation.
- LOW/INFO may be fixed opportunistically only when existing write authority already covers an obvious localized change. Validate that fix locally, but never send LOW/INFO to rebuttal, investigate adjacent hypotheticals, start or extend a reviewer round, or escalate because of it. The review itself grants no write authority.

The lead validates contract compliance and materiality; it does not invent findings to fill reviewer coverage gaps.

## Lifecycle

1. Create a fresh `invocation_id`. Every worker prompt includes its stable batch fields, selected pair, `review_type`, one-pass focus, `finding_id_prefix` containing the batch id, `output_mode: full_review`, and `baseline: commit:<hash> | working-tree`. Require Round 1 to read every target. For diffs, use `git diff <hash> -- <paths>` or both `git diff -- <paths>` and `git diff --cached -- <paths>`.
2. Spawn complete batch pairs up to capacity. Save each `sessionId` and non-null `spawnPromptMessageId`; when the latter is null, establish a reply anchor with `send_message`. Announce active and queued batches, then end the turn.
3. On later turns, dispatch queued pairs as capacity opens. Validate ids and coverage, reconcile duplicates and integration evidence, and classify findings.
4. When eligible challenged findings exist, send them to the paired reviewer sessions with `output_mode: rebuttal`. Require one `agree | disagree | uncertain` verdict per id and no unrelated findings. Batch messages per recipient, announce dispatch, and end the turn. LOW/INFO never enter rebuttal.
5. Finalize classifications after the bounded rebuttal. If separately authorized, an obvious LOW/INFO fix may be applied with focused lead-side validation, but it cannot cause another reviewer message or pass.
6. Shut down all workers, remove this invocation's cache, and report. Do not apply material fixes, start a second review round, or silently escalate.

After any spawn or message whose useful next step depends on a reviewer reply, return control instead of polling. Check status only when the user asks or a worker has no reply and no activity for at least 30 minutes; send at most one nudge before using failure handling.

## Failure

- For start, auth, sandbox, timeout, or thread-state failure: shut down the worker and retry the same batch, adapter, provider/runtime selector, `agentName`, and model type at most twice. Never substitute an unselected reviewer. If it still fails, mark the batch incomplete and ask the user whether to wait, continue with explicitly downgraded evidence, or abort.
- On `⚠ FRESH SESSION`, shut down and respawn that worker, then resend the full Round 1 batch prompt.
- On `⚠ SCOPE PATH MISMATCH`, correct paths or the cache manifest, then shut down, respawn, and resend the full prompt.
- Follow MCP errors as returned. A failed spawn or send never changes the confirmed pair.

## Report

Report scope, baseline, batches and dependencies, reviewer pair and worker ids, retries, per-worker coverage and restrictions, findings with status and rebuttal evidence, MEDIUM materiality decisions, any opportunistic LOW/INFO fix plus validation, and shutdown/cache cleanup status.

Recommend exactly one of `NO_BLOCKING_EVIDENCE`, `BLOCKING_EVIDENCE`, `INCOMPLETE_REVIEW`, or `ESCALATE_TO_DEEP_REVIEW`; LOW/INFO alone never justify escalation. End with `Final decision: USER_DECISION_REQUIRED`.
