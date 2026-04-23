# CHANGELOG_43: Claude thinking（内部推理）单独识别并弱化渲染

## 概要

修「Claude assistant 消息里把模型的内部推理（thinking）当成普通 final answer 渲染」的 bug。截图现象：同一帧 SDK assistant message 里出现两个 type='text' content block，前者是模型的推理 prelude（`**Responding to a casual greeting**\n\nI think the user just said hello...`），后者才是真正的 final answer（`Hello. What do you need help with?`）。当前 `sdk-bridge.ts` 逐 block emit 'message'，UI 把这两条都渲染成同等地位的 `MessageBubble`，用户感知"Claude 自言自语了一段然后才回答"。

新增 `AgentEventKind = 'thinking'` 第一公民类型贯通 SDK 翻译 → 状态机 → DB → UI 全链路。`sdk-bridge` 双重识别：(1) 标准 Anthropic API 的 `BetaThinkingBlock { type:'thinking', thinking }` 走专用分支；(2) 同一帧出现连续 type='text' block 时，前 N-1 个判定为 thinking-prelude（这是 Claude Code 把 extended thinking 压平成 text 推给 SDK 用户的实际产物形态）。UI 新增弱化样式的 `ThinkingBubble`（dashed 边框 + 暗背景 + 斜体淡灰文字 + 头部标 `thinking`），与 final answer 的 `MessageBubble`（实线边框 + 不淡化）视觉上区分但同时间线展示。

## 变更内容

### shared 类型（`src/shared/types.ts`）

- `AgentEventKind` 加 `'thinking'` 联合分支，与 `'message'` 平级
- 不改 payload 结构：thinking event 的 payload 形如 `{ text: string }`，与 message 共用 `{ text }` 字段约定（少一个 `role`，因为 thinking 永远是 assistant）

### SDK bridge（`src/main/adapters/claude-code/sdk-bridge.ts:880-940`）

`msg.type === 'assistant'` 分支重写 content block 循环：

- **真 thinking block**：`block.type === 'thinking'` → emit `'thinking' { text: block.thinking }`；`'redacted_thinking'` → emit `'thinking' { text: '[redacted thinking]' }`（按 Anthropic API 规范字段名）
- **多 text block 启发式**：`block.type === 'text'` 时，看下一个紧邻 block 是不是另一个 text block——是 → 当前是 thinking-prelude（emit `'thinking'`）；否 → final answer（emit `'message'`）
- **判断条件覆盖矩阵**（已注释在代码里）：
  - `[text, text]` → `[thinking, message]` ✅（用户截图场景）
  - `[text, tool_use]` → `[message]` ✅（"我去查一下" + 工具调用，前面那段不算 thinking）
  - `[text, tool_use, text]` → `[message, message]` ✅（被 tool_use 隔开的两段都是 message）
  - `[text, text, tool_use]` → `[thinking, message]` ✅
  - `[thinking_block, text]` → `[thinking, message]` ✅（真 thinking block 走第一条规则）

### 主进程状态机（`src/main/session/manager.ts:344-347`）

- `nextActivityState` switch 加 `case 'thinking':` 与 `'message' / 'tool-use-start' / 'file-changed'` 同处理 → `'working'`
- 语义：模型在思考 = 在工作，与 final answer 同等触发 active 状态推进

### renderer UI（`src/renderer/components/ActivityFeed.tsx`）

- `MessageRow` 加 `event.kind === 'thinking'` 分支 → `<ThinkingBubble event={event} />`
- 新增 `ThinkingBubble` 组件（紧跟 `MessageBubble` 后面）：
  - 视觉差异：`border-dashed border-deck-border/40 bg-white/[0.02]` + `italic text-deck-muted` —— dashed 边框、更暗背景、斜体淡灰文字
  - 头部 `thinking` 标签代替 `Claude`（uppercase + tracking-wider 等宽字体），时间戳同样位置
  - MD/TXT toggle 复用与 `MessageBubble` 同样的 plaintext / markdown 切换（thinking 也可能是 markdown）
  - 默认展开，不引入折叠（暂时；如果后续用户嫌长再加）

### 不动的地方（写明避免后人重新评估）

- **hook 通道**：双对抗 Agent 已核实 hook 通道（`hook-routes.ts` / `hook-server/`）只处理 6 类 hook 事件 + Notification → waiting-for-user / PostToolUse → tool-use-end，**不解析 transcript 内容**，thinking 永远不会从 hook 通道进入。无需改动。
- **summarizer**（`src/main/session/summarizer.ts`）：thinking 不被 `events.find((e) => e.kind === 'message')`（line 145）匹配，不会被误当成 final answer 拼进 LLM 总结上下文（line 169 `formatEventsForPrompt` 也只 if 'message'）。**有意为之**：thinking 是模型的草稿，已经被 final answer 浓缩，再让总结 LLM 读 thinking 既冗余又会推高 token 成本
- **SessionCard 卡片概要**（`src/renderer/components/SessionCard.tsx:166-193`）：`formatEventLine` switch 没匹配 thinking → 落到 `default: return null`，循环找下一条更具体的事件。语义合理（thinking 不是有信息量的活动，不应抢卡片摘要的位置）
- **DB 持久化**（`src/main/store/event-repo.ts:30`）：generic insert，`kind` 直接存字符串字段，不需要改 schema

## 设计取舍

- **判断条件用「下一个紧邻是不是 text」而不是「数 text block 总数」**：后者会把合理的 `[text, tool_use, text]` 模式（中间被工具隔开的两段说明）误判为「前面是 thinking」；前者只命中真正的连续 text 序列，对所有合理形态都正确
- **不靠文本特征启发式（如 markdown bold 标题前缀）识别 thinking**：模型 final answer 也可能以 `**...**` 标题开头（结构化回答常见），靠文本特征会有误判；而「同一帧多 text block」是 SDK 层面的结构信号，更稳
- **UI 默认展开 thinking 不折叠**：用户现状是看不见 thinking 被独立标记 → 改后能看见且与 final answer 区分开就解决了主要痛点；折叠会引入「点开才能看」的额外操作成本，先观察用户实际反馈再决定要不要加（避免过度设计）
- **不修改 shared payload 结构（不加 `role: 'thinking'`）**：用 kind 字段区分 thinking / message 比 role 字段更对称（kind 是联合类型有 TS 穷举检查，role 加新值要改更多地方）
- **状态机让 thinking 算 'working'**：模型在思考期间，session 应保持 active；如果让 thinking 不切状态，会出现「最后一个事件是 thinking 但 activity 没变 working」的违反直觉行为
- **hook 通道不需要改**：双对抗 Agent 已核实 hook 通道完全不解析 transcript，thinking 不会从那条路径进来。如果后续真的把 hook 改成解析 transcript（未来需求），那时再考虑加 thinking 翻译

## 验证

- `pnpm typecheck` 通过（main + web 两份 tsconfig）
- 用户手动重启 dev（`pnpm dev`），新建一个会话发 `hello`，应该看到：
  - 第一条：`thinking` 弱化气泡（dashed 边框 + 斜体淡灰），内容是模型的推理 prelude
  - 第二条：`Claude` 实线气泡，内容是 final answer
- 旧 DB 里历史 message 不会回追改写（迁移会很贵）：已有的 thinking 内容仍然存在 `kind='message'` 行，只对新会话生效。可接受（最多看着旧会话双 bubble 怪异，不影响功能）

## 追加：codex 也走 thinking + 气泡头部按 agentId 显示对方名

### 起因

CHANGELOG_43 主体只覆盖了 Claude 通道，但用户切到 codex 会话后立即暴露两个遗漏：

1. **Codex（GPT-5）reasoning 没走新通道**：`codex-cli/translate.ts:105` 原本 `emit('message', { text, role:'assistant', reasoning: true })`，UI 完全不读 `reasoning` 字段（rg 全 src 只在 translate.ts 自己写入和注释），全部当 final answer 渲染。GPT-5 reasoning 与 Claude extended thinking 是同一产品语义，应共用 `ThinkingBubble`
2. **MessageBubble 头部 hardcoded 'Claude'**（[ActivityFeed.tsx:281](src/renderer/components/ActivityFeed.tsx#L281)）：codex 会话里对方名仍显示 "Claude"，与 SessionDetail 的 placeholder「给 Codex 发消息」（[SessionDetail.tsx:339](src/renderer/components/SessionDetail.tsx#L339)）不一致

### 改动

#### `src/main/adapters/codex-cli/translate.ts`

- L105 `case 'reasoning':` 从 `emit('message', { text, role:'assistant', reasoning: true })` 改为 `emit('thinking', { text })`，与 Claude 路径统一
- 文件顶部事件映射注释 L15 同步更新：`item.completed{reasoning} → thinking`
- `reasoning: true` 字段没别处依赖，删除安全

#### `src/renderer/components/ActivityFeed.tsx`

- 顶部新增 `getAgentShortName(agentId): string` helper：`'codex-cli' → 'Codex'`、`'aider' → 'Aider'`、`'generic-pty' → 'Shell'`，default `'Claude'`。注释说明：`adapter.displayName`（'Claude Code' / 'Codex CLI'）是长名给 NewSessionDialog 选 adapter 用，气泡头部需要更短的人称
- `MessageBubble` 加 `agentId` props，第 281 行 `{isUser ? '你' : 'Claude'}` → `{isUser ? '你' : otherName}`（`otherName = getAgentShortName(agentId)`）
- `ThinkingBubble` 加 `agentId` props，头部由单独 `'thinking'` 标签改为「{otherName} · thinking · {ts}」三段式（与 MessageBubble 头部「{otherName} · {ts}」结构对齐，多一段 thinking 状语让用户知道这是推理而非 final answer）
- `MessageRow` 调用 `<MessageBubble />` / `<ThinkingBubble />` 时把已有的 `agentId` 透下去

### 不动的地方

- **`SessionDetail.tsx:339` 的 inline ternary 不重构**：只此一处用，重构成调 helper 收益小；未来如果第 4 处需要再统一抽
- **`adapter.displayName` 保留长名**：'Claude Code' / 'Codex CLI' 在 NewSessionDialog 列表里需要让用户分辨「Claude Code (CLI 工具)」vs「Codex (GPT-5)」，与气泡头部的人称短名是两套语境，各自为政更清晰

### 验证补充

- 新建 codex 会话发任意消息，应看到：
  - reasoning 段：`Codex · thinking · {ts}` 弱化 dashed 气泡
  - final answer：`Codex` 实线气泡
- 同时新建 claude 会话验证未受影响：`Claude · thinking · {ts}` / `Claude` 两种气泡都正常

