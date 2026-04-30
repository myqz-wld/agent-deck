# CHANGELOG_49: deep-code-review skill 接入 milestone task 跟踪

## 概要

deep-code-review skill 之前 SKILL.md 全程走 SendMessage（CHANGELOG_44 设计），TeamDetail「hook 事件流」section 永远只有 TeammateIdle，看不出当前 Round / 反驳轮进度，复盘也没机器化时间线。本期 +32 行加 §Milestone tracking 子节，定义 5 个 milestone 处主动调 `mcp__tasks__task_create` / `task_update`（Round 起 / Round 收 / 反驳轮起 / 反驳轮裁决落锤 / 收口校验），中间讨论照旧 SendMessage（teammate context 持久化主路径不变）。`enableTaskManager: true` OFF 时整段 task_* 跳过、不阻断主流程。

## 变更内容

### resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md

- §核心设计 末加 §Milestone tracking 子节（task vs SendMessage 分工 + 5 milestone 调用模板表 + 前置 `enableTaskManager` + 约束三条）
- §Step 2 末「注意」列表加一条：spawn 完调 `task_create` 建 `R_1`
- §Step 3 末加 task 节奏段：每条 HIGH 反驳轮 sendMessage 之前建 `B_N_X`，裁决落锤后 `task_update` 写裁决理由
- §Step 5 末加 task 节奏段：Round N+1 sendMessage 之前建 `R_(N+1)` 并 `blocked_by: [R_N]` 记 round 依赖
- §Step 6 cleanup 之前加 task list 收口校验（`task_list status_filter:"active"` 应 0；`task_list({})` 全量贴一次作为机器化复盘起点）
- §关键约束 加约束 8：task list 是进度通道不是裁决通道；description 一句话状态摘要；OFF 时整段跳过不阻断主流程
- §常见反模式 加两条：Round / 反驳轮起前漏 task_create + task description 抄 finding 全文

## 备注

- 不破坏 CHANGELOG_44 落地的 SendMessage 主路径（teammate 跨轮 context 持久化是 deep-code-review 核心 gain）；task list 仅作为**进度可见性**通道补充
- 不动 README：line 19 已说 hook 事件流三类、line 169 已说 SDK Task Manager 5 个工具存在，工作流关联不到 README 收口阈值
- 不走「决策对抗」：本期是已讨论方案落地（用户已选定方向「改吧」），非新决策；属 skill 工作流增强不是 CLAUDE.md 项目硬约定升级
- 验证：现有会话需重启 SDK 才能加载新 SKILL.md（spawn-time 注入）；enableTaskManager OFF 用户须先去 SettingsDialog → 实验功能 → 开启 SDK Task Manager（CHANGELOG_43 默认 OFF）
- **已知风险（待观察）**：sdk-bridge.ts:614 给每条 SDK 会话统一注入 `allowedTools: ['mcp__tasks__*']`，in-process teammate（reviewer-claude / reviewer-codex）也拿得到 task 工具；写锁仅按 team 隔离不按 lead/teammate 角色隔离；reviewer agents/*.md 当前没禁用 task_*。理论上 teammate 可能自发 `task_create` 跟踪自己内部进度，把 lead 的 `R_N` / `B_N_X` 干净序列污染。**本期不预防**——运行后看实际是否真出现，再决定走 (a) reviewer agents 加硬约束 / (b) tools.ts 加 isLeadAgent 检查 / (c) sdk-bridge spawn-time 按 lead 身份动态决定 allowedTools 三种修法。lead 看到奇怪 task 时可主动 `task_update(status:"abandoned")` 兜底。
