# CHANGELOG_47: 活动流工具行展示增强 + toolName 双通道漏传 bug 修复

## 概要

围绕用户在会话详情活动流里看到「Skill 调用只显示 `Skill` 二字」「`工具 完成` 不带工具名」「所有工具图标都是 🔧」三类体感缺陷，做一次全 ActivityFeed + SessionCard 的工具行展示增强；过程中现场实证发现 SDK + Codex 两条通道 emit `tool-use-end` 时都漏传 `toolName`（hook 通道正常），顺手一并修。

走双异构对抗（Explore subagent + 外部 codex CLI gpt-5.5 xhigh）+ 三态裁决：plan 草稿被推翻 2 处（Codex 通道补 toolName + SessionCard 同步），扩充图标白名单（实证 7 天 jq tool_use 频次驱动），TodoWrite 改 📌 避撞「一轮完成」状态的 ✅，ToolEndRow 加图标对称由用户拍板。

## 变更内容

### 主进程 — emit `tool-use-end` 补 `toolName`（HIGH bug 修复）

#### `src/main/adapters/claude-code/sdk-bridge.ts:1810-1820`

- `internal.toolUseNames` Map 在 line 1791-1794（assistant `tool_use` 时）已 set，但 user `tool_result` 处理 emit `tool-use-end` 时一直没 get 出来，renderer 只能兜底成 `工具`。
- 补一行从 map 反查：`const toolName = block.tool_use_id ? internal.toolUseNames.get(block.tool_use_id) : undefined`，emit 时塞进 payload。
- 仅 `get` 不 `delete`：`maybeEmitImageFileChanged`（line 1816）内部还要用同一个 map 然后 delete（`sdk-bridge.ts:1931-1933`），所以 emit 之前 get、不动 delete 时序，map 不膨胀。

#### `src/main/adapters/codex-cli/translate.ts:114, 146, 163`

Codex 通道三处 `tool-use-end` emit 全没传 `toolName`，但对应的 `tool-use-start`（line 82 / 89 / 159）都已经拼好。直接对齐：

- `command_execution` end → `toolName: 'Bash'`（与 line 82 start 对齐）
- `mcp_tool_call` end → `` toolName: `mcp__${i.server}__${i.tool}` ``（与 line 89 start 对齐）
- `web_search` end → `toolName: 'WebSearch'`（与 line 159 start 对齐）

#### 关键不动项

- **不改 hook 通道 `claude-code/translate.ts`**：PostToolUse 已经传 `toolName: p.tool_name`（`translate.ts:347`），正常。

### Renderer — 工具图标体系 + Skill 展示

#### 新建 `src/renderer/components/activity-feed/tool-icons.ts`

集中维护 `toolIcon(tool: string | null | undefined): string` 映射，单一真理来源。

- 风格保留纯 emoji（与现有 ExitPlanMode 📋 / Task 🤖 / ImageRead 🖼 / file-changed 📝 一致），不引入 lucide-react 避免 bundle 体积膨胀
- 高频白名单基于本仓库 7 天 transcript jq 频次实证（截止 2026-05-01）：Bash 1889 / Read 1650 / Edit 774 / TodoWrite 340 / Grep 235 / Write 176 / AskUserQuestion 80 / Agent 78 / TaskOutput 48 / Glob 41 / WebFetch 27 / WebSearch 22 / SendMessage 21 / ExitPlanMode 15 / TaskStop 10 / Skill 7 / EnterPlanMode 7 / TeamCreate 6 / Task 3
- 避撞约束：✅ 已被「一轮完成」状态用 → TodoWrite 改 📌；📝 file-changed 占用不复用；📋 ExitPlanMode 已用，EnterPlanMode 配对复用；🤖 Task 已用，Agent 是 Task 在新版 Claude Code SDK 的别名同样复用
- 当前覆盖：📖 Read / ✍️ Edit/Write/MultiEdit / 📓 NotebookEdit / 🗂 Glob / 🔍 Grep / 💻 Bash / 🌐 WebFetch+WebSearch / 📌 TodoWrite / 📋 ExitPlanMode+EnterPlanMode / 🤖 Task+Agent / ✨ Skill / ❓ AskUserQuestion / 📨 SendMessage / ➕ TaskCreate / 🔄 TaskUpdate / 📤 TaskOutput / 🛑 TaskStop / 👥 TeamCreate；其他 mcp__* 兜底 🔧

#### `src/renderer/components/activity-feed/describe.ts`

- `describeToolInput` 加 `case 'Skill'`：从 input 提取 `{ skill: string, args?: string }`，输出 `${skill} · ${argsShort}`（args 60 字截断）。Shape 来自 26 条 jsonl tool_use 实证（skill 全 string、args 14 条 string + 12 条 absent，未发现 null/object）
- SimpleRow fallback `describe()` 的 `tool-use-start` 与 `tool-use-end` 改用 `toolIcon(tool)`，与 ToolStartRow / ToolEndRow 主路径风格统一

#### `src/renderer/components/activity-feed/rows/tool-row.tsx`

- ToolStartRow 通用分支 `<span>🔧</span>` → `<span>{toolIcon(tool)}</span>`（line 115）；Skill 由 `describeToolInput('Skill', ...)` 自动给 detail，通用分支不需要新增 if-Skill 特化
- ExitPlanMode（line 43）、Task（line 71）的硬编码 emoji 也走 `toolIcon('ExitPlanMode')` / `toolIcon('Task')`，保持单一真理来源；plan markdown 展开 / subagent_type 标签 / prompt 折叠等专属 UI 完全不动
- ToolEndRow（line 175）加图标对称（用户拍板）：`{imageRead ? '🖼 ImageRead' : ${toolIcon(tool)} ${tool}} 完成`。imageRead 分支保持原行为不被新逻辑顶掉

#### `src/renderer/components/SessionCard.tsx:177-180`

- 会话卡片实时摘要也硬编码 `🔧 ${tool}`，同步改用 `toolIcon`（import 自 `./activity-feed/tool-icons`）
- 自带的 `summariseToolInput`（line 204）加 Skill case（与 describe.ts 同款 60 字截断）

> 后续：`SessionCard.summariseToolInput` 与 `describe.ts:describeToolInput` 是两份重复实现的历史债，下次专门重构合并到 `tool-describe.ts` 共享，本次不做。

## 验证

- `pnpm typecheck` ✅
- 手验场景（dev 起来后触发）：
  1. **Skill**：`/hello` 类 skill → `✨ Skill · agent-deck:hello-from-deck` + `✨ Skill 完成`
  2. **Bash / Edit / Read / WebFetch / TodoWrite**：分别拿到 💻 / ✍️ / 📖 / 🌐 / 📌 图标
  3. **Codex 会话回归**（关键）：起 codex 会话跑 Bash → 也应是 `💻 Bash 完成`，不再是「工具 完成」
  4. **MCP 图片工具回归**：`mcp__*__ImageRead` / `ImageWrite` 仍走 `🖼 ImageRead 完成` 原路径，[provider · model] 后缀正常
  5. **Task / Agent subagent 回归**：`🤖 Task → general-purpose ...` + `🤖 Task 完成`
  6. **会话卡片摘要**：会话列表里某条最近 tool-use-start 的图标也跟着切，不再永远 🔧

## 备注

- bug 修复部分（SDK + Codex 通道 toolName 漏传）在 plan 阶段已经走完双异构对抗（Explore subagent + 外部 codex CLI gpt-5.5 xhigh），三态裁决全部记入 `~/.claude/plans/jiggly-forging-wind.md`，不另开 `reviews/REVIEW_X.md`
- 关联待落地的 plan / 决策：
  - REVIEW_16（fs watcher symlink path mismatch）是另一条独立 debug fix，pure debug 不写 CHANGELOG，按 CLAUDE.md 归 reviews/ 即可
  - 本次未实施的 follow-up：未给 toolIcon 加 vitest 单测（plan 阶段对抗 reviewer 标 LOW，可后续单独加）；未合并 SessionCard 与 describe.ts 的两份 `summariseToolInput` / `describeToolInput`（历史债标注）

## 补丁 1：补低频高频工具 detail + ToolEndRow 事后配对

实施完上面后用户反馈 Agent / TeamCreate 行光秃秃没 detail、Skill 完成行没显示具体 skill 名。根因：`describeToolInput` 没这几个 case；`tool-use-end` payload 不带 toolInput 所以 ToolEndRow 看不到 input.skill。补一波：

### `src/renderer/components/activity-feed/describe.ts`

`describeToolInput` 加 case（实证 input shape 来自 `~/.claude/projects/.../*.jsonl`）：

- `Agent`（与 Task 同 case）：复用 Task 的 `subagent_type · prompt(60字)` 摘要 —— Agent 是新版 Claude Code SDK 的 Task 别名，shape 完全一致 `{subagent_type, prompt, description}`
- `TeamCreate`：`{team_name, description}` → `team_name · description(60字)`
- `SendMessage`：`{to|recipient, message, type?, summary?}` → `→ recipient · summary|message-snippet|<type>`，message 字段实证可能是 string 也可能是结构化 object（`permission_response` / `shutdown_request` 等），分支兜底
- `TaskOutput`：Claude Code builtin 读 background bash task 输出，`{task_id, block, timeout}` → `task_id · 阻塞|非阻塞`
- `TaskStop`：Claude Code builtin 停 background bash task，`{task_id|shell_id}` → 显示 id

### `src/renderer/components/activity-feed/rows/tool-row.tsx`

- ToolStartRow Task 特化分支扩成 `tool === 'Task' || tool === 'Agent'`，分支内 `<span className="font-mono">Task</span>` 改成 `{tool}` —— Agent 调用也走同款 subagent_type chip + 折叠 prompt 按钮，不再走通用的「图标 + 工具名」光秃秃分支
- ToolEndRow signature 加 `startEvent?: AgentEvent` prop。两个用法：
  1. `tool` 兜底链：`payload.toolName ?? startEvent.payload.toolName ?? '工具'` —— 老 events（修复 SDK toolName 漏传 bug 之前持久化的）也能补回名字，只要前一条 start 还在 `RECENT_LIMIT` 窗口里
  2. `detail` 反查：`describeToolInput(tool, startEvent.payload.toolInput)` —— 让「✨ Skill 完成」补回「· agent-deck:deep-code-review」，「💻 Bash 完成」补回 cmd 摘要，「🤖 Agent 完成」补回 subagent_type，等等
- imageRead 分支独占 `[provider · model]` 后缀，不再叠 detail 防一行三段太挤

### `src/renderer/components/activity-feed/index.tsx`

- 新增 `toolStartByUseId` useMemo：扫一遍 recent events build `Map<toolUseId, startEvent>`，与 cancelled* useMemo 一组共依赖 [recent]，跟着 recent 一起重算
- `RowProps` / ActivityRow / dispatch 路径透传 `toolStartByUseId`；ActivityRow 渲染 `tool-use-end` 时 `map.get(payload.toolUseId)` 拿 startEvent 传进 ToolEndRow
- 副作用：跨 RECENT_LIMIT 窗口（默认 30 条）的 end 仍兜不到 detail / 老 toolName，保持「工具 完成」兜底，是边界情况（start/end 通常几秒内紧挨着）

### 不动项

- 不在 `tool-use-end` emit 时多塞 toolInput（避免 events 表写放大；Agent prompt 上百行场景代价高）—— renderer 事后配对零持久化层改动达成同样效果
- 不补 `Teammate` case（实证 jsonl 没采到样本，shape 不明，先留空白兜底；后续触发到再加）
- 不动 SessionCard.tsx 的 `summariseToolInput`（仍是历史债，只在 ToolStartRow / SimpleRow 路径补；SessionCard 的 1 行摘要场景对低频工具 detail 不那么紧要）

### 验证

- `pnpm typecheck` ✅
- 手验追加场景：
  - Agent 调用：`🤖 Agent → agent-deck:reviewer-claude [展开 prompt]`（与 Task 同款）+ `🤖 Agent 完成 · agent-deck:reviewer-claude · <prompt 60 字>`
  - TeamCreate：`👥 TeamCreate · dcr-tm-44b · deep-code-review for commit 4d9f40b ...`
  - SendMessage：`📨 SendMessage · → reviewer-claude · 协议违反纠正 ...`
  - Skill 完成行：`▸ ✨ Skill 完成 · agent-deck:deep-code-review`（补回 skill 名）
  - 老会话回滚验证：dev 重启前已经有的「工具 完成」会话，重启后如果对应 tool-use-start 还在窗口里，应该自动补回工具名 + detail；超出窗口的仍维持「工具 完成」是预期
