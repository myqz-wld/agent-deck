---
name: simple-review
description: "Run exactly one independent review round and one bounded rebuttal with two user-confirmed heterogeneous reviewers, then present evidence for the user's judgment."
---

# Simple Review

Use this skill for focused code, plan, prompt-asset, technical-decision, or overall-change review. Do not turn it into a fix-and-review loop.

## Reviewer Selection

Require exactly two distinct user-confirmed slots:

| Reviewer | Spawn |
|---|---|
| `reviewer-claude` | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| `reviewer-codex` | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |
| `reviewer-deepseek` | `spawn_session({ adapter: 'deepseek-claude-code', agentName: 'reviewer-deepseek', model: 'deepseek-v4-pro[1m]', cwd, teamName, displayName, prompt })` |
| `reviewer-grok` | `spawn_session({ adapter: 'grok-build', agentName: 'reviewer-grok', cwd, teamName, displayName, prompt })` |

If the user has not selected a pair, ask and stop. Reject duplicates and every selection that is not exactly two. Spawn the selected pair concurrently and record it in both prompts.

If a reviewer fails, shut it down and respawn the same adapter, agent name, and model slot. Never substitute another candidate.

## Review Packet

Give both reviewers the same invocation id, absolute scope paths, baseline, review type, focus, selected pair, and `output_mode: full_review`. Give each a distinct finding id prefix.

Reviewers work read-only and independently. When their replies are required, follow the Agent Deck wait boundary instead of polling.

## One Review Round

1. Collect both full reviews.
2. Normalize findings by stable id, severity, evidence, and decision impact.
3. Send one bounded rebuttal packet to each reviewer containing only the other reviewer's relevant challenged findings and `output_mode: rebuttal`.
4. Collect both rebuttals; do not start another round.

## Result

Present:

- selected reviewer pair and coverage;
- agreed findings;
- disputed or uncertain findings with both sides' evidence;
- routine fix direction versus major decision points;
- your recommendation.

Leave the final judgment to the user. Do not modify files unless the user separately asks for implementation.
