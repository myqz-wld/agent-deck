# Architecture Diagrams

> plantUML 架构图(component / 模块依赖 / 跨进程边界)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [archive-plan-architecture.puml](archive-plan-architecture.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan 主进程模块依赖架构 (component): handler facade (285) → impl 主体 (1281,批 A R1 F1 拆分 -14%) → 2 helpers (precheck + index-sync) + DEFAULT_DEPS/SharedDeps 注入 (F9 4 impl 共用) + runBatonCleanup (shutdownTeammatesOnBaton + archiveSourceSessionWithEmit) + sessionRepo/agentDeckTeamRepo (SQLite WAL) + eventBus + fs (mainRepo/worktree/ref/plans/spike-reports) + git CLI |
| [archive-plan-state-machine.puml](archive-plan-state-machine.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan 改变的 5 entity 并行 state 联动 (state diagram): plan frontmatter (in_progress→completed) + worktree dir (exists→removed) + git branch (exists→merged→deleted) + cwdReleaseMarker (set→null F10 修法提前) + caller+teammate sessions (active→teammate closed→all archived) — 原子时序 + Step 1-6/7a/7b-c 阶段失败兜底说明 + hand_off baton 时序对比 |

