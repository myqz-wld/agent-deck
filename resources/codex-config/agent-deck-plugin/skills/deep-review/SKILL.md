---
name: deep-review
description: "Run multi-round review with exactly two confirmed heterogeneous reviewer slots selected from reviewer-claude, reviewer-codex, and reviewer-deepseek for complex code, plans, or mixed plan-and-code changes; use for deep race, lifecycle, architecture, security, performance, or plan-gate risk. Requires evidence and rebuttal for CRITICAL/HIGH findings and blocks until they are fixed or disproved. Chinese anchors: 深度 review, 双对抗 review, review agent 深挖, 再 review 一轮, 深挖整体改动是否符合预期, and plan 评审."
---

# Deep Review

Run a multi-round `review -> fix -> review` loop until the two selected heterogeneous reviewers stop finding new material issues or the gate is blocked. Use this skill for depth: round 1 catches obvious correctness and consistency defects; later rounds pressure-test races, lifecycle leaks, plan invariants, architecture, security, performance, and test gaps.

Agent Deck MCP tools must be available. Use `mcp__agent-deck__spawn_session`, `send_message`, `get_session`, and `shutdown_session` for reviewer orchestration. Keep the executable protocol in this skill; use the runtime Agent Deck backend rules only for message delivery details, team scoping, and tool error semantics.

## When To Use

- `kind: "code"`: critical-path code, core abstractions, concurrency, lifecycle, resource management, security boundaries, multi-module changes, or final merge gates.
- `kind: "plan"`: RFCs, implementation plans, workflow designs, invariant definitions, line-level references, handoff plans, and test matrices.
- `kind: "mixed"`: changes where the plan and implementation must be reviewed together for design-to-code consistency.
- Do not use this skill for trivial edits, obvious wording fixes, single-file renames, or review work that only needs one quick pass.

## Scope Contract

The caller must provide typed scope. Do not infer review kind from file extensions.

```ts
{
  kind: "code" | "plan" | "mixed",
  paths: string[],
  reviewers?: [
    "reviewer-claude" | "reviewer-codex" | "reviewer-deepseek",
    "reviewer-claude" | "reviewer-codex" | "reviewer-deepseek"
  ],
  ack_cache_unignored?: boolean
}
```

Caller requirements:

- `kind` is mandatory.
- `paths` are absolute paths.
- `reviewers` must contain exactly two distinct selected slots before spawn; if it is absent, ask the user to choose two and stop.
- Each batch stays small enough for reviewers to inspect directly: prefer <= 10 files and <= 30 prompt lines of path/context text.
- Paths normally share the reviewer `cwd` prefix. Paths outside `cwd` are allowed only through the staging flow below.
- In worktree reviews, code paths must point at the worktree copy, not the base checkout.

## Staging External Paths

Define `reviewRoot` as the absolute `cwd` passed to reviewer sessions. Before spawning reviewers, stage any scoped file outside `reviewRoot` into `<reviewRoot>/.deep-review-cache/<invocationId>/` so reviewer sandboxes can read it.

Run staging in step 0:

1. Generate `invocationId = sha256(timestamp + random)[0:8]`.
2. Sweep old staging directories by reading `<reviewRoot>/.deep-review-cache/*/manifest.json`; delete invocation directories whose `createdAt` is older than 24 hours.
3. Check `<reviewRoot>/.gitignore` for a `.deep-review-cache/` entry. If it is missing and `ack_cache_unignored` is not true, warn the caller that staged files may be committed accidentally, then stop for explicit consent.
4. For every scoped path outside `reviewRoot`, copy it to `<reviewRoot>/.deep-review-cache/<invocationId>/<fileSha8>-<sanitized-basename>`, where `fileSha8 = sha256(original absolute path)[0:8]` and `sanitized-basename` keeps only `A-Za-z0-9._-`.
5. Write `<reviewRoot>/.deep-review-cache/<invocationId>/manifest.json`:

```json
{
  "invocationId": "<invocationId>",
  "createdAt": "<ISO timestamp>",
  "files": [
    {
      "origAbspath": "/Users/.../external-inputs/foo.md",
      "cachePath": "<reviewRoot>/.deep-review-cache/<invocationId>/<fileSha8>-foo.md"
    }
  ]
}
```

6. Send reviewers the staged paths instead of the original external paths.
7. On final cleanup, remove only `<reviewRoot>/.deep-review-cache/<invocationId>/`. Use a try/finally pattern so cleanup still runs after review failures.

If staging fails because of permissions, missing files, or disk space, abort the skill and tell the caller to stage the files manually or fix the environment before retrying.

## Reviewer Slot Selection

Every review round must use the same two confirmed heterogeneous reviewer slots. If no selection is already provided, ask the user to choose exactly two slots and stop this turn; do not silently default.

| Reviewer | Adapter |
|---|---|
| `reviewer-claude` | `claude-code` |
| `reviewer-codex` | `codex-cli` |
| `reviewer-deepseek` | `deepseek-claude-code`, model `deepseek-v4-pro[1m]` |

Reject duplicate slots, one slot, or three slots. The selected slots must be heterogeneous by adapter / provider slot; the bundled slots above are distinct. Record `reviewer_selection` in every reviewer prompt and in the final report. Do not pass `permissionMode`, `claudeCodeSandbox`, or `codexSandbox` unless the user explicitly requested that override.

Spawn the selected reviewers concurrently in round 1. Reuse the same reviewer sessions in later rounds with `send_message`; do not respawn between rounds unless a failure path requires it.

The lead adapter does not matter. Any lead can select any valid two-slot combination. Reviewers stay independent: they do not contact each other and do not read or judge the other reviewer's conclusions except in explicit rebuttal rounds. The lead adjudicates.

Never replace a failed selected reviewer with an unselected slot or a duplicate of the surviving reviewer. Heterogeneity is part of the gate.

## Round Focus

| Round | `kind: "code"` | `kind: "plan"` | `kind: "mixed"` |
|---|---|---|---|
| 1 | Correctness, regressions, tests | Workflow consistency, design clarity, checklist completeness | Run both code and plan focus |
| 2 | Edge cases, races, resource lifecycle | Invariant boundaries, line references, test matrix coverage | Run both code and plan focus |
| 3 | Architecture coupling, security, tail performance | Phase drift, conflicting triggers, missing fallback paths | Run both code and plan focus |
| 4+ | Previous residuals and user focus areas | Previous residuals and user focus areas | Previous residuals and user focus areas |

For `kind: "mixed"`, still spawn only two reviewers. The prompt is larger because each reviewer evaluates both the plan and the implementation, so expect roughly double prompt cost per reviewer, not four reviewer sessions.

## Adjudication

Every finding receives one lead outcome:

- `ACCEPTED`: A real issue. CRITICAL/HIGH findings require either independent agreement from both reviewers or one reviewer plus lead-side verification.
- `REBUTTED`: The finding is disproved by the other reviewer or by lead-side checks. Record the rebuttal evidence.
- `UNVERIFIED`: Lead outcome for a finding that may be real but lacks evidence. Downgrade severity to MEDIUM or lower.

CRITICAL/HIGH rules:

- Every CRITICAL/HIGH finding needs a rebuttal record before final adjudication.
- If only one reviewer reports it, send the full finding to the other reviewer for rebuttal.
- If both reviewers independently report it, still request or write a rebuttal that tests whether the severity is truly CRITICAL/HIGH.
- Final adjudication must record support, rebuttal, and the lead decision.

Single-reviewer findings:

- CRITICAL/HIGH: run the rebuttal path above.
- MEDIUM: the lead checks quickly with search/read commands or at most one focused test. Keep the check under about 5 minutes, 5 searches, and 1 test. If still uncertain, assign lead outcome `UNVERIFIED` and downgrade severity to LOW/INFO.
- LOW/INFO: assign lead outcome `UNVERIFIED` unless the lead can confirm it cheaply.

Severity is based on real impact and trigger likelihood, not reviewer confidence. Lack of evidence lowers severity.

| Severity | Use When | Gate |
|---|---|---|
| CRITICAL (P0) | Stable data loss, permission bypass, secret disclosure, arbitrary code execution, severe cross-session mixup, or global main-path outage without a reliable workaround | Must fix or disprove; blocks merge |
| HIGH (P1) | Reproducible crash, deadlock, state corruption, security boundary break, user work loss, core wrong result, or stable regression for a class of users | Must fix or disprove; blocks merge |
| MEDIUM (P2) | Real defect with a workaround or limited trigger scope; risky change missing regression tests; misleading prompt/docs that can cause wrong agent action without breaking a hard safety boundary | Lead must fix now, accept risk, or record follow-up |
| LOW (P3) | Small edge case, minor UX/text drift, readability or maintainability improvement with low likelihood and reversible impact | Record only |
| INFO (P4) | Context, caveat, confirmed non-issue, coverage note, or improvement idea | Context only |

## Gate Conditions

Pass only when both selected reviewers approve, no CRITICAL/HIGH finding remains, all accepted CRITICAL/HIGH fixes have been tested, and every MEDIUM has a lead disposition.

Block when any CRITICAL/HIGH remains unfixed or undisproved, reviewers keep finding substantial new issues, or the user stops the workflow.

## Workflow

Turn boundary: after sending reviewer work in steps 2, 4, or 5, tell the user what was dispatched and end the current response. Do not use sleep, busy polling, or repeated `get_session` checks while waiting. Reviewer replies arrive later as user-role messages; continue adjudication when they appear.

1. Prepare `cwd`, `scope`, and staging. Use the staged path list for reviewer prompts.
2. Spawn the two selected reviewers concurrently:
   - `spawn_session({ adapter: "claude-code", agentName: "reviewer-claude", cwd, teamName, displayName, prompt })`
   - `spawn_session({ adapter: "codex-cli", agentName: "reviewer-codex", cwd, teamName, displayName, prompt })`
   - `spawn_session({ adapter: "deepseek-claude-code", agentName: "reviewer-deepseek", model: "deepseek-v4-pro[1m]", cwd, teamName, displayName, prompt })`
   Run only the two selected spawn calls.
   Save each `sessionId` and `spawnPromptMessageId`.
3. Tell the user that the two selected reviewers are running, progress is visible in the UI, and replies will be injected when complete. End the response.
4. When reviewer findings arrive, adjudicate with the tri-state rules. For CRITICAL/HIGH, enter a rebuttal round.
5. Rebuttal round: send the full finding to the other reviewer with `send_message({ sessionId, teamId, replyToMessageId, text })`, ask for independent rebuttal, then end the response. When the rebuttal arrives, finalize the finding or downgrade it.
6. Fix accepted CRITICAL/HIGH issues. For MEDIUM, choose `fix now`, `accept risk`, or `follow-up`. Start the next review round with the same reviewer sessions and a `skip` list in this format: `fixed: <filepath:line> <one-sentence change> (commit <hash> | working tree)`. End the response and return to adjudication when replies arrive.
7. Finish only after the gate passes or blocks. Then shut down both reviewer sessions, clean the staging directory for this invocation, and deliver the final summary report.

Do not shut down reviewer sessions during the fix loop. Keeping the same pair preserves cross-round context. If the next round may happen hours later, leave sessions active or dormant and resume them with `send_message`.

## Stuck Reviewers

Check reviewer progress only when the user asks for status or when no reply has arrived and the last reviewer activity is at least 30 minutes old.

1. Call `get_session(reviewerSid)` and inspect `lastEventAt`.
2. If it is recent, tell the user the reviewer is still running and end the response.
3. If it is stale, send a nudge with `send_message` on the last reply chain, asking the reviewer to reply with either findings or a progress note. End the response.
4. If the reviewer remains stale after the next threshold, use the failure fallback for that reviewer.

Do not keep consuming lead context by repeatedly checking in one turn.

## Prompt Fields

Each spawn or round prompt must include:

- `output_mode`: `full_review` or `rebuttal`.
- `reviewer_selection`: the exact two selected slots and each slot's adapter, `agentName`, and model when the slot sets one.
- `scope`: absolute paths, using staged cache paths for external files.
- `focus`: the current round's row from the Round Focus table, expanded with wording from the focus blocks below; do not send the full multi-round menu.
- `finding_contract`: location, snippet, verification, severity, fix direction, and example requirements.
- `skip`: accepted fixes and stable items from previous rounds.

Code focus:

```text
- correctness and regression risk
- edge cases, races, and resource lifecycle
- architecture coupling, security, and tail performance
- regression test coverage for each fix
```

Plan focus:

```text
- design decisions and invariant boundaries
- line-level references, function names, and file paths match current code
- workflow consistency and evidence folded into decisions
- test matrix covers each invariant
- next-session first step is executable from a cold start
- known risks and historical issues are complete
```

Mixed focus:

```text
- evaluate the implementation with code focus
- evaluate the plan with plan focus
- verify plan decisions and invariants are enforced by the implementation
```

## Finding Contract

Every reviewer finding must include:

- `file:line` plus a code or text snippet of at most 6 lines.
- Verification method, such as search evidence, a focused test, a command result, or a precise reasoning check.
- User-facing example for complex findings: name the concrete trigger path, state sequence, input, or plan step and the visible failure.
- Fix direction in 1-2 lines. Do not ask reviewers to write a full patch.
- Severity bucket: CRITICAL, HIGH, MEDIUM, LOW, or INFO. When validation is limited, keep the severity bucket and add `*unverified*` in the heading or first description line.

Lead spot-checks:

- Missing location, snippet, verification, or fix direction means assign lead outcome `UNVERIFIED` or `REBUTTED`.
- Complex findings without a concrete example get lead outcome `UNVERIFIED`; if they claim CRITICAL/HIGH, ask the reviewer to add the example before rebuttal.
- Weak language such as "maybe", "might", "looks like", or "probably" is allowed only in findings marked `*unverified*`.
- Pure text reasoning cannot become accepted CRITICAL/HIGH without independent agreement or lead-side verification plus rebuttal.

## Failure Fallbacks

| Failure | Required Action |
|---|---|
| A selected reviewer fails to start, loses auth, hits sandbox denial, times out, reports tool-call cancellation, or loses its thread state | Shut down the failed reviewer, respawn the same selected adapter / `agentName` / model slot, and retry up to 2 times within about 5 minutes per attempt. If it still fails, offer: wait for recovery, continue with single-side findings from the surviving selected reviewer downgraded through single-reviewer adjudication, or abort. Never respawn an unselected slot and never duplicate the survivor. |
| Reviewer reports `⚠ FRESH SESSION` or equivalent empty-memory state | Shut down that reviewer, respawn the same adapter/agent, and restart from the round 1 full prompt for the current scope. Do not continue round N+1 with lost context. |
| Reviewer reports `⚠ SCOPE PATH MISMATCH` | Fix the path list or staging manifest, shut down affected reviewers, respawn, and resend the full prompt. |
| Reviewer remains stuck after status check and nudge | Ask the user to resolve pending UI approvals if relevant, or use the same-adapter respawn fallback above. |
| `kind: "mixed"` loses one reviewer | Run the retry and respawn chain first. If only one reviewer remains, its findings cannot become CRITICAL/HIGH unless they pass single-reviewer adjudication with lead-side verification and rebuttal. |
| Staging external files fails | Abort and report the failed path and reason. |

## Final Summary Report

When the workflow passes, blocks, aborts, or escalates, report:

- Scope, review kind, reviewed paths, and number of rounds.
- Final gate: PASS, BLOCKED, ABORTED, or ESCALATED.
- Reviewer coverage: selected slots, both session ids, retry/fallback status, and whether the two-slot heterogeneity stayed intact.
- Findings by severity and tri-state outcome, including CRITICAL/HIGH support, rebuttal, and lead decision.
- Complex accepted findings with a short concrete example.
- Fix and decision log: changed files, commands/tests run, MEDIUM dispositions, accepted risks, and follow-ups.
- Cleanup status: reviewer shutdown and staging cleanup.

Do not finish a deep review with only "done" or "review passed".

## Relation To Simple Review

Use `simple-review` for a single-pass sanity check, focused decision review, small plan review, or technical-policy check. Use `deep-review` when the scope needs multiple rounds, rebuttal, cross-round reviewer context, race/lifecycle/security depth, or mixed plan-to-code validation. If a simple review reveals deeper risk, start a deep review with the same scope and continue from the next round focus.
