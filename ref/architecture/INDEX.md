# Architecture Diagrams

> plantUML 架构图(component / 模块依赖 / 跨进程边界)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [agent-deck-mcp-architecture.puml](agent-deck-mcp-architecture.puml) | active | commit 7475b75 + d5549c6 + 8a41517 / [REVIEW_59](../reviews/REVIEW_59.md) | MCP 服务器顶层概览(5 大块 + 跨切组件 + cross-ref 8 张专题子图) |
| [archive-plan-architecture.puml](archive-plan-architecture.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan 模块架构(plan 收口 5 大块,7 步原子时序主链路) |
| [archive-plan-state-machine.puml](archive-plan-state-machine.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | archive_plan 5 entity 并行 state 联动(plan / worktree / branch / marker / sessions) |
| [hand-off-session-architecture.puml](hand-off-session-architecture.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session 模块架构(baton 接力 5 大块,spawn + adopt + task + cleanup) |
| [hand-off-session-state-machine.puml](hand-off-session-state-machine.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session 6 entity 并行 state 联动(双模式 / adopt / task 三态 / cleanup) |
| [sdk-bridge-architecture.puml](sdk-bridge-architecture.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) | sdk-bridge 双端(claude / codex)模块架构(5 大块对偶,SDK 子进程 + jsonl 边界) |
| [sdk-bridge-state-machine.puml](sdk-bridge-state-machine.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) | sdk-bridge 5 entity 跨层 state 联动(内存 Map / sdkOwned / DB lifecycle / 单飞锁 / CLI rename) |
| [universal-message-status-state-machine.puml](universal-message-status-state-machine.puml) | active | commit d5549c6 / [REVIEW_61](../reviews/REVIEW_61.md) | 消息状态机(pending / delivering / delivered / failed / cancelled + crash recovery) |
