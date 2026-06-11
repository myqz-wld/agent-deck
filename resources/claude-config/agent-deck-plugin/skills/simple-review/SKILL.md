---
name: simple-review
description: "Run a one-pass heterogeneous reviewer-claude + reviewer-codex check for code, plans, prompt assets, technical decisions, agent validation, overall-change validation, post-edit prompt-asset validation, or Chinese anchors such as 简单 review, 轻量 review, 帮我 review, 这个对不对, 对抗一下, 决策评审, and 整体改动是否符合预期. Blocks completion until CRITICAL/HIGH findings are fixed or disproven."
---

# Simple Review

Use this skill when a single code change, plan, prompt asset, agent instruction, technical decision, or completed diff needs a fast heterogeneous adversarial review. It starts reviewer-claude and reviewer-codex once, compares their independent findings, and gives the user a final gate decision.

Use `deep-review` instead when scope spans many modules, needs multiple fix rounds, mixes code and plan review, or requires deep race/security/architecture investigation.

## Preconditions

Run this skill only when Agent Deck MCP tools are available. If `spawn_session`, `send_message`, `shutdown_session`, or task/session tools are missing, stop and ask for manual review or an environment with Agent Deck MCP enabled.

The lead owns adjudication. Reviewers produce evidence; they do not decide whether to merge.

## Inputs

The caller must pass typed scope:

```ts
{
  kind: 'code' | 'plan' | 'prompt',
  paths: string[],
  ack_cache_unignored?: boolean
}
```

- `kind` is mandatory; do not infer it from file extensions.
- Use `kind: 'prompt'` for system prompts, agent bodies, `SKILL.md`, MCP/tool descriptions, and other durable AI-facing instructions.
- `paths` must be absolute paths.
- Paths should be inside the same repo/worktree root as `cwd`; paths outside that root are copied into the sandbox cache before spawning reviewers.
- Keep a single invocation small enough for one pass. If the scope is broad, split by topic or use `deep-review`.

## Prompt Asset Reviews

Use `kind: 'prompt'` as the expected validation pass after material prompt-asset edits. Do not skip it only because reviewer replies arrive in a later turn. Reviewer priorities come from the Prompt focus template below.

## Sandbox Cache

Copy any path outside `reviewRoot` into a readable cache before spawning reviewers.

- `reviewRoot` is the absolute `cwd` used for reviewer spawn.
- Cache root: `<reviewRoot>/.deep-review-cache/<invocationId>/`.
- `invocationId`: fresh short id for this skill run.
- Cache filename: `<fileSha8>-<sanitized-basename>.md`, where `fileSha8` hashes the original absolute path and `sanitized-basename` removes unsafe filename characters.
- Manifest: write `manifest.json` beside cache files with `invocationId`, `createdAt`, and `{ origAbspath, cachePath }[]`.

Startup checks:

- Sweep cache invocation directories older than 24h.
- Check `<reviewRoot>/.gitignore` for `.deep-review-cache/`. If missing and `ack_cache_unignored` is not true, warn and stop for explicit user consent.

Cleanup:

- After review finishes or aborts, remove only this invocation cache directory.
- If cleanup fails, report the exact failed path. Copy failures follow the Failure Handling table.

## Reviewer Pair

Spawn both reviewers in parallel and keep the pair heterogeneous:

| Reviewer | Spawn |
|---|---|
| reviewer-claude | `spawn_session({ adapter: 'claude-code', agentName: 'reviewer-claude', cwd, teamName, displayName, prompt })` |
| reviewer-codex | `spawn_session({ adapter: 'codex-cli', agentName: 'reviewer-codex', cwd, teamName, displayName, prompt })` |

Never replace a failed reviewer with a second reviewer from the same adapter family. If one side fails, use the fallback table below.

## Turn Boundary

After spawning reviewers or sending rebuttal/Round 2 prompts, tell the user what was dispatched and end the current turn. Reviewer replies arrive as later Agent Deck user-role messages; continue adjudication when they arrive. Do not use `sleep`, busy loops, or repeated `get_session` polling in the same turn.

## Workflow

| Step | Action |
|---|---|
| 0 | Normalize `scope`, create sandbox cache for external paths, and build the reviewer prompt from the templates below. |
| 1 | Spawn reviewer-claude and reviewer-codex without waiting between spawns. Record each `sessionId`, `teamId`, and `spawnPromptMessageId`. |
| 2 | Tell the user that both reviewers are running and replies will arrive through Agent Deck messages; then end the current turn. |
| 3 | When both reviewer replies arrive, adjudicate every finding with the tri-state rules below. |
| 4 | For every CRITICAL/HIGH finding, send one rebuttal request to the opposite reviewer using `send_message` and the relevant reply chain anchor; then end the current turn. |
| 5 | If a real CRITICAL/HIGH is fixed, reuse the same reviewers for one optional Round 2. Send only the fix diff and `skip` summary; then end the current turn. Do not respawn unless a fresh-session or scope mismatch warning requires it. |
| 6 | Finish with reviewer shutdown, cache cleanup, and the final summary report. |

Stop after one fix round unless the result still has CRITICAL/HIGH findings or many new true findings. Escalate that case to `deep-review`.

## Tri-State Adjudication

Each finding gets one outcome:

- ✅ **True issue**: both reviewers independently report it, or one reviewer reports it and the lead verifies it with search/read/command/test evidence.
- ❌ **Rebutted**: the opposite reviewer or lead verification disproves it.
- ❓ **Partial / unverified**: evidence is incomplete or based on weak text-only reasoning. Downgrade to MEDIUM or lower.

CRITICAL/HIGH findings require a rebuttal record before final decision. If both reviewers report the issue, still ask one side to challenge severity or exploitability.

Single-reviewer findings:

- CRITICAL/HIGH: run rebuttal.
- MEDIUM: lead verifies with a small bounded check; otherwise downgrade or record accepted risk.
- LOW/INFO: record as context or follow-up.

## Severity

Severity follows real impact and trigger likelihood; uncertainty lowers severity.

| Level | Use When | Gate |
|---|---|---|
| CRITICAL (P0) | Stable data loss, permission bypass, secret leak, arbitrary code execution, severe cross-session mixup, or total core-path outage without workaround. | Block until fixed or disproven; rebuttal required. |
| HIGH (P1) | Reproducible crash, deadlock, state corruption, security boundary break, user work loss, core wrong result, or stable regression for a user class. | Block until fixed or disproven; rebuttal required. |
| MEDIUM (P2) | Real defect with workaround, limited trigger surface, non-core impact, missing key regression test, or prompt/doc issue that can mislead an agent without breaking safety. | Lead records fix, accepted risk, or follow-up. |
| LOW (P3) | Small edge issue, minor UX/copy drift, readability or maintainability improvement with low reversible impact. | Record only. |
| INFO (P4) | Context, coverage note, caveat, non-action observation, or confirmed no-issue risk. | Record only. |

## Finding Contract

Lead must spot-check reviewer findings. A valid finding includes:

- `file:line` and a source snippet of at most 6 lines.
- Verification method, such as grep results, a failing test, command output, or direct code reading.
- Fix direction in 1-2 lines, not a full patch.
- Severity from CRITICAL / HIGH / MEDIUM / LOW / INFO; add `*unverified*` only when validation is limited.
- For complex race, lifecycle, architecture, security, performance, or multi-step plan issues: a concrete user-facing example with the trigger path, state sequence, input, or plan step and the visible failure.

Invalid findings are downgraded or rejected when they lack location, snippet, verification, fix direction, or a concrete example for complex claims.

Weak assertion words such as "maybe", "might", "probably", "可能 / 也许 / 看起来 / 应该 / 大概" are allowed only in `*unverified*` findings.

## Prompt Templates

Every reviewer prompt must include:

- `output_mode: full_review` or `output_mode: rebuttal`.
- `scope`: absolute paths after sandbox-cache replacement.
- `focus`: review priorities.
- `finding_contract`: location, snippet, verification, severity, fix direction, and complex-issue example requirements.
- `skip`: only for Round 2, summarizing fixed or stable items.

Code focus:

```text
- Fix correctness and regressions.
- Relevant edge cases, concurrency, lifecycle, security, or performance risks.
- Regression test coverage for key fixes.
```

Plan focus:

```text
- Decisions and invariants are clear.
- Workflow is internally consistent.
- Next handoff step is executable from a cold start.
```

Prompt focus:

```text
- Instructions change the next agent action at task time.
- Safety, tool, validation, and failure-handling gates are preserved.
- Paired assets stay behaviorally aligned while preserving adapter-specific mechanics.
- No stale, duplicated, or contradictory rules; no hidden local assumptions or local-only maintenance rules leak into reusable assets.
```

Rebuttal prompt:

```text
output_mode: rebuttal
Review only this finding from the other reviewer.
Give one stance: agree / disagree / uncertain.
Do not add unrelated findings.
<finding text>
```

## Failure Handling

| Situation | Action |
|---|---|
| Either reviewer fails | Shutdown the failed session and respawn the same agent on its own adapter (reviewer-claude with `adapter: 'claude-code'`, reviewer-codex with `adapter: 'codex-cli'`); retry at most twice and keep the surviving reviewer. If it still fails, ask the user to wait, proceed with single-reviewer downgraded findings, or abort. Never respawn on the other adapter; the pair must not become two same-family reviewers. |
| reviewer reports `⚠ FRESH SESSION` | Shutdown and respawn that reviewer, then rerun Round 1 with full scope. Do not continue Round 2. |
| reviewer reports `⚠ SCOPE PATH MISMATCH` | Fix the scope path or cache manifest, then shutdown, respawn, and resend the prompt. |
| reviewer does not reply for 30 minutes | Only after the threshold or a user status request, check `get_session(lastEventAt)`. If recent, tell the user it is still running and end the turn; otherwise ask the user to resolve pending UI approvals if relevant or respawn. |
| sandbox cache copy fails | Warn with the exact failed path, abort this review, and ask caller to provide readable paths. Do not invent findings for unreadable files. |
| MCP send/spawn errors | Follow the MCP tool error. Do not silently downgrade to same-adapter reviewers. |

## Final Summary Report

Before ending the workflow, report:

- Scope, kind, and reviewed paths.
- Final gate: PASS / BLOCKED / ABORTED / ESCALATED_TO_DEEP_REVIEW.
- Reviewer coverage: session ids, retries, and whether the heterogeneous pair stayed intact.
- Findings by severity and tri-state outcome, including CRITICAL/HIGH support, rebuttal, and lead decision.
- Complex finding examples for accepted complex issues.
- Fix and decision log: files changed, tests or commands run, MEDIUM disposition, accepted risk, and follow-ups.
- Cleanup status: reviewer shutdown and sandbox cache cleanup.

Do not finish with only "done" or "review passed".
