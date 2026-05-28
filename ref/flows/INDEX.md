# Flow Diagrams

> plantUML 流程图(sequence / activity)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [archive-plan-flow.puml](archive-plan-flow.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan mcp tool 7 步原子收口 sequence (caller → handler → impl → runBatonCleanup) 含 4 态预检 / spike-reports mv / INDEX smart update / teammate shutdown / caller archive |
| [archive-plan-precheck-decision.puml](archive-plan-precheck-decision.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan 4 态笛卡尔预检 + 原子 7 步收口失败 phaseHint 决策树 activity (cwdReleaseMarker × cwd 在 worktree 内 4 状态 + plan status / worktree dirty / detached HEAD / mainRepo critical paths / plan_id cross-check 短路 + ff-merge fail phaseHint + spike-reports mv fail + runBatonCleanup phase 1+2) |

