---
name: deep-review
description: "Run iterative heterogeneous review rounds with exactly two user-confirmed reviewers for complex lifecycle, architecture, security, concurrency, performance, plan, or design-to-code risks."
---

# Deep Review

Use this skill when the task needs iterative evidence, in-scope remediation, and re-review. Ask the user mid-process only when the remedy requires a major architecture or scope decision.

## Reviewer Selection

Require exactly two distinct user-confirmed slots:

| Reviewer | Spawn |
|---|---|
| `reviewer-claude` | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| `reviewer-codex` | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |
| `reviewer-deepseek` | `spawn_session({ adapter: 'deepseek-claude-code', agentName: 'reviewer-deepseek', model: 'deepseek-v4-pro[1m]', cwd, teamName, displayName, prompt })` |
| `reviewer-grok` | `spawn_session({ adapter: 'grok-build', agentName: 'reviewer-grok', cwd, teamName, displayName, prompt })` |

Ask the user if the pair is not confirmed. Reject every selection that is not exactly two, then keep the same pair for the whole invocation.

If one selected reviewer fails, shut it down and respawn the same adapter, agent name, and model slot. Do not replace it or duplicate the survivor.

## Preparation

Create or update a durable plan and a task record. Define:

- invocation id and selected pair;
- absolute scope and baseline;
- review type and current focus;
- invariants and explicit exclusions;
- validation commands known to preserve user changes;
- the major-decision boundary.

## Round Protocol

For each round:

1. Send both reviewers the same scope, baseline, focus, selected pair, and `output_mode: full_review`, with distinct finding prefixes.
2. Let them inspect independently and read-only.
3. Collect both replies through Agent Deck messages; do not poll while waiting.
4. Verify and deduplicate findings locally.
5. Send one bounded `output_mode: rebuttal` packet per reviewer for contested findings.
6. Classify each finding as accepted, rejected, uncertain, or major-decision.

Routine in-scope fixes may be implemented autonomously when the user already authorized changes. Validate them, then start the next focused round against the updated baseline.

Stop and ask the user before a fix that changes architecture, subsystem ownership, a core abstraction, public API or protocol, persistence, security boundaries, compatibility, destructive behavior, major dependencies, or material scope/risk tradeoffs.

## Convergence

Finish when:

- both reviewers report complete coverage for the final focus;
- no accepted CRITICAL or HIGH finding remains;
- routine accepted findings are fixed or explicitly deferred with reason;
- disputed findings have evidence and a lead verdict;
- required validation passes without changing unrelated user work.

Do not chase an arbitrary zero-finding result. A stable, evidence-backed disagreement may be reported as such.

## Final Report

Report the selected pair, rounds and focuses, coverage, accepted fixes, remaining risks, disputed findings, validation, and any user decision still required. Update the task and durable plan to match reality.
