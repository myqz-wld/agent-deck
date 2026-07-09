---
plan_id: diff-walkthrough-presentation-contract-20260623
created_at: 2026-06-23
status: completed
worktree_path: /Users/wanglidong/Repository/agent-deck
base_commit: 2a7b2c8930b5bf422c587883df8a69ccb51cf242
---

# Diff Walkthrough Presentation Contract

## Goal And Invariants

Update Agent Deck MCP self-description and Skill Market `diff-walkthrough` skills so step-by-step diff walkthroughs default to an interactive presentation gate instead of inline pasted diff text.

Invariants:

- Skill Market skill text must identify presentation tools by capability, not by any concrete tool, server, or product name.
- Inline text remains available only as a fallback when the environment has no interactive presentation tool.
- PR fragments map to before/after two-column shape; merge-conflict fragments map to ours/theirs/resolution shape.
- Tool decisions drive the loop: approved advances, revise re-presents the current fragment, stop/timeout ends.
- The MCP tool description may name its own tool and modes, because it is describing itself, and should be expanded for readability.
- Walkthroughs may include concise annotations or explanation inside presented fragment content when it helps identify fields, functions, callers, logic, or purpose.

## Confirmed Scope

Editable Agent Deck assets:

- `/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/tools/index.ts`
- `/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/tools/schemas.ts`

Agent Deck counterpart check only:

- `/Users/wanglidong/Repository/agent-deck/resources/claude-config/CLAUDE.md`
- `/Users/wanglidong/Repository/agent-deck/resources/codex-config/CODEX_AGENTS.md`

Editable Skill Market assets:

- `/Users/wanglidong/Repository/skill-market/skills/claude/diff-walkthrough/SKILL.md`
- `/Users/wanglidong/Repository/skill-market/skills/codex/diff-walkthrough/SKILL.md`

Skill Market metadata check only:

- `/Users/wanglidong/Repository/skill-market/skills/claude/diff-walkthrough/agents/openai.yaml`
- `/Users/wanglidong/Repository/skill-market/skills/codex/diff-walkthrough/agents/openai.yaml`

Installed user skill copies under `~/.claude` and `~/.codex` are comparison targets only unless scope is explicitly expanded.

## Tasks

| Task | Owner | Status | Validation |
|------|-------|--------|------------|
| Refresh prompt-asset inventory and backup editable assets | lead | completed | Backup batch `20260623T081219Z` written under each repo `.prompt-asset-improver/local/backups/` |
| Focused prompt-asset edit pass for Agent Deck MCP descriptions | focused agent | completed | Focused agent edited `present_diff` descriptions; lead inspected diff |
| Focused prompt-asset edit pass for Skill Market skills | focused agent | completed | Claude/Codex skill bodies remain aligned; lead made small wording fix |
| Lead merge and validation | lead | completed | Agent Deck typecheck and targeted MCP tests passed; Skill Market frontmatter/YAML, identity, portability, catalog, and diff checks passed |
| Independent prompt-asset review and records | lead + reviewer | completed | `CHANGELOG_320` and `REVIEW_138` added; reviewer LOW findings fixed and INFO findings accepted |

## Risks

- If the Skill Market skill names Agent Deck-specific tools, portability is lost.
- If the skill keeps "use a tool or inline text" as a peer choice, agents may continue to choose inline text.
- If MCP descriptions do not explain the `before`/`after` plus `unifiedDiff` relationship, callers may omit multi-hunk context.
- If annotation guidance only appears in the skill and not in MCP schema descriptions, callers may not know where to put explanatory comments.

## Next-Session First Action

Plan completed. If this work resumes, inspect the archived records, then continue from any new user-requested follow-up rather than reopening this implementation plan.
