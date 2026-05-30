# Architecture Diagrams

> plantUML 架构图(component / 模块依赖 / 跨进程边界)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [agent-deck-mcp-architecture.puml](agent-deck-mcp-architecture.puml) | active | commit 7475b75 + d5549c6 + 8a41517 / [REVIEW_59](../reviews/REVIEW_59.md) / deep-review-and-asset-polish-20260530 Phase F | MCP 服务器顶层概览(5 大块 + 跨切组件 + cross-ref 各主题子图; 17 tool / 5 数据表含 issue) |
| [archive-plan-architecture.puml](archive-plan-architecture.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) / [REVIEW_64](../reviews/REVIEW_64.md) | archive_plan 模块架构(plan 收口 5 大块,4 子模块原子收口: precheck fail-fast + post-ff-merge manual recovery + cleanup) |
| [archive-plan-state-machine.puml](archive-plan-state-machine.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) / [REVIEW_64](../reviews/REVIEW_64.md) | archive_plan 5 entity 并行 state 联动(plan/worktree/branch/marker/sessions, 4 子模块原子收口) |
| [hand-off-session-architecture.puml](hand-off-session-architecture.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session 模块架构(baton 接力 5 大块,spawn+adopt+task+cleanup) |
| [hand-off-session-state-machine.puml](hand-off-session-state-machine.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session 6 entity 并行 state 联动(双模式/adopt/task/cleanup) |
| [sdk-bridge-architecture.puml](sdk-bridge-architecture.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) / [REVIEW_64](../reviews/REVIEW_64.md) | sdk-bridge 双端模块架构(5 大块对偶,SDK 子进程 + jsonl 边界, applicationSid stable + cli_session_id update) |
| [sdk-bridge-state-machine.puml](sdk-bridge-state-machine.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) / [REVIEW_64](../reviews/REVIEW_64.md) | sdk-bridge 5 entity 跨层 state 联动(内存 Map/lifecycle/单飞锁/applicationSid stable + cli_session_id update) |
| [universal-message-status-state-machine.puml](universal-message-status-state-machine.puml) | active | commit d5549c6 / [REVIEW_61](../reviews/REVIEW_61.md) / [REVIEW_64](../reviews/REVIEW_64.md) | 消息状态机(pending/delivering/delivered/failed/cancelled + crash recovery + spawn 捷径 markDelivered 直跳) |
| [issue-tracker-architecture.puml](issue-tracker-architecture.puml) | active | [issue-tracker-mcp-20260529](../plans/issue-tracker-mcp-20260529.md) / deep-review-and-asset-polish-20260530 Phase F | issue-tracker 跨进程架构(agent 写 mcp / UI 读改删 IPC 6 channel / GC 调度 / event→renderer + FK SET NULL vs CASCADE) |
| [issue-tracker-state-machine.puml](issue-tracker-state-machine.puml) | active | [issue-tracker-mcp-20260529](../plans/issue-tracker-mcp-20260529.md) / deep-review-and-asset-polish-20260530 Phase F | issue 生命周期 state(status 3 态仅 UI 推进 + soft-delete/GC 双轨硬删, status×deleted_at 正交) |
| [runtime-logging-architecture.puml](runtime-logging-architecture.puml) | active | [runtime-logging-electron-log-20260529](../plans/runtime-logging-electron-log-20260529.md) / deep-review-and-asset-polish-20260530 Phase F | runtime-logging 双进程架构(electron-log v5: main+renderer console 接管 / IPC bridge / file transport rotation+cleanup / LogsSection IPC) |
