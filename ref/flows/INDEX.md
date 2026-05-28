# Flow Diagrams

> plantUML 流程图(sequence / activity)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [archive-plan-flow.puml](archive-plan-flow.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan mcp tool 7 步原子收口 sequence (caller → handler → impl → runBatonCleanup) 含 4 态预检 / spike-reports mv / INDEX smart update / teammate shutdown / caller archive |
| [archive-plan-precheck-decision.puml](archive-plan-precheck-decision.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan 4 态笛卡尔预检 + 原子 7 步收口失败 phaseHint 决策树 activity (cwdReleaseMarker × cwd 在 worktree 内 4 状态 + plan status / worktree dirty / detached HEAD / mainRepo critical paths / plan_id cross-check 短路 + ff-merge fail phaseHint + spike-reports mv fail + runBatonCleanup phase 1+2) |
| [hand-off-session-flow.puml](hand-off-session-flow.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session baton 接力全链路 sequence (caller → handler → impl → spawn → adopt → task reassign → runBatonCleanup) — plan-driven / generic 双模式 + CHANGELOG_99 cwd resilience + adopt_teammates phase 1.5 swapLead + task 三态 (clear-team / preserve-team / skip) + phase 1+2 cleanup |
| [hand-off-session-decision.puml](hand-off-session-decision.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session 双模式分流 + cwd resilience + adopt_teammates ≥1 lead 硬约束 + task 三态 + cleanup 决策树 activity (plan-driven 4 reject endpoint + generic 路径 + cwd 兜底链 + phase 1.5 firstTeam fatal vs 非 firstTeam 软失败 + task 三态分流 + cleanup phase 1/2 skip 条件) |
| [sdk-bridge-resume-recovery-flow.puml](sdk-bridge-resume-recovery-flow.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) | sdk-bridge sendMessage 主路径 vs recoverAndSend 单飞 vs jsonl-missing fallback sequence (双端 cross-adapter parity) — sessions.has 主路径 / recovering Map single-flight 锁 / sessionRepo unarchive / cwd 启发式 fallback / jsonl missing fresh-session + renameSdkSession 子表迁移 / 正常 resume 路径 + CLI 软 fork detect rename |
| [sdk-bridge-recovery-decision.puml](sdk-bridge-recovery-decision.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) | sdk-bridge sendMessage 5 路径决策树 activity (主路径 sessions.has / recovering inflight 等待 / cwd 启发式 fallback / jsonl-missing fresh-session / 正常 resume + CLI 软 fork rename 路径) — REVIEW_60 R1+R2+R3 修法关联 |

