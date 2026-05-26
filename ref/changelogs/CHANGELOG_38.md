# CHANGELOG_38: ActivityFeed Task 工具专门渲染（subagent_type / 折叠 prompt）

## 概要

修体感痛点：deep-code-review skill / Agent Teams 触发后会大量出现 `Task` 工具调用（spawn reviewer-claude / reviewer-codex / general-purpose teammate 等），但 ActivityFeed 当前对 Task 没有特殊渲染——只显示「🔧 Task」一个图标 + 名字，**subagent_type / prompt 全文 / 描述全部不可见**，用户看不出这条 Task 在 spawn 谁、给了什么任务。本次给 Task 加专门 case：subagent_type 紫色 chip 标显 + 单行 prompt 摘要 + 「展开 prompt」按钮看完整指令文本（仿 diff 折叠模式）。subagent 的返回值不动 ToolEndRow 既有的 ▸/▾ 折叠模式 — 已经覆盖。

## 变更内容

### `src/renderer/components/activity-feed/describe.ts`

`describeToolInput()` 加 `Task` case，返回 `${subagent_type} · ${prompt 头 60 字}…`。这条 fallback 给 SimpleRow 用（ActivityFeed 部分场景走简单一行而非 ToolStartRow）。

### `src/renderer/components/activity-feed/rows/tool-row.tsx`

`ToolStartRow` 加 `if (tool === 'Task')` 专门分支（同 ExitPlanMode 的位置约定）：

- **顶部行**：
  - 🤖 图标 + `Task` 名字
  - subagent_type 紫色 chip：`→ agent-deck:reviewer-claude`（`title` tooltip 显示完整字符串以防长名截断）
  - 「展开 prompt / 收起 prompt」按钮（仅当 prompt 非空时显示，仿 diff 折叠按钮风格）
  - 时间戳右对齐
- **中间行（折叠态）**：
  - `description` 字段（如果 SDK 给了，比如 Task call 带了 `description: "lint check"`）
  - prompt 单行摘要（≤80 字截断，hover 标 title 看完整文本）
- **展开态**：
  - 折叠区域：max-h-96 + overflow-auto + Markdown 渲染完整 prompt 文本
  - 容器用 `bg-black/20 border-deck-border/40` 跟 ExitPlanMode plan 渲染同模式

新增 `useState taskPromptOpen`（与既有 `diffOpen` 并列），独立控制 Task prompt 折叠态，不复用 diffOpen 避免语义混乱。

## 不动的部分（说明）

- **ToolEndRow（subagent 返回）不改**：现有 ▸/▾ 折叠展开 result 已经能完整显示 subagent 最终输出（`toolResult` 字段），Task 专门处理只需补 ToolStartRow 的 input 侧
- **diff 渲染逻辑不动**：Task 的 toolInput 不是文件 diff，`toolInputToDiff(tool, p.toolInput)` 对 Task 返回 null，diff 按钮自然不出现
- **不加 reviewer 颜色区分**：subagent_type chip 统一用 status-working 紫调（与 SessionCard 的 SDK chip 同色系），不针对 reviewer-claude / reviewer-codex 单独配色——MessageView 没有这种粒度信号需求

## 备注

- 触发场景：deep-code-review skill / 决策对抗主路径 spawn 两个 reviewer / Agent Teams lead 自己 spawn teammate（如果 lead 跑在 SDK 会话内）/ 用户自定义 subagent
- 完整 prompt 长度上限：UI 没硬限，但 max-h-96 + overflow-auto 防撑爆视窗。**深度 review 的 prompt 经常上百行**（含 scope + focus + skip + 完整约束）—— 折叠后想看就点、不想看不占空间
- 渲染只动 renderer 层，HMR 自动推送，不需要重启 dev
- Task 工具的 toolInput 字段约定来自 Claude Agent SDK：`subagent_type` (string) + `prompt` (string) + 可选 `description` (string，调用方给的简短自述)
- 验证：在跑过 deep-code-review 或 spawn 过 reviewer-claude 的会话里看 SessionDetail 活动流，旧的「🔧 Task」应该变成「🤖 Task → agent-deck:reviewer-claude [展开 prompt]」紫色 chip 高亮版
