# CHANGELOG_19: ActivityFeed 拆模块 + 顺手补初始化 race（含 6 候选对抗评估附录）

## 概要

用户开放性问「看看有没有可以优化的地方」。两路 Explore 列出 6 个高 ROI 候选，按「决策对抗」规范开 Claude Opus 4.7 xhigh + Codex gpt-5.4 xhigh 两个异构 Agent 独立评估，三态裁决后**仅候选 4（ActivityFeed 拆分）双方一致推荐做**，本次落地。其余 5 个候选（adapter 公共层 / IPC handler 拆 / useIpcWithSequence hook / events generated column / summaryMaxConcurrent UI）按对抗结论记录后不做（理由见末尾附录）。

顺手并入 Claude 独发的隐藏第 7 项：ActivityFeed 初始化 useEffect 加 aborted flag 防切会话快时残留 race（影响小，0 额外投入）。

## 变更内容

### `src/renderer/components/activity-feed/`（新建目录，替代旧 `ActivityFeed.tsx` 695 行单文件）

按职责拆 8 个文件，最大 231 行（含 ActivityRow dispatcher），最小 18 行：

- `index.tsx`（231 行）— 容器：state 订阅 + `useEffect` 加载（**含 aborted flag 修复**）+ pending/cancelled 集合派生 + `ActivityRow` dispatcher
- `shared.ts`（32 行）— `RenderMode` / `DEFAULT_RENDER_MODE` / `getAgentShortName` / `EMPTY_EVENTS`
- `format.ts`（103 行）— `eventKey` / `formatToolResult` / `parseImageReadResult`
- `describe.ts`（74 行）— `describe(event)` / `describeToolInput(toolName, input)`
- `rows/message-row.tsx`（86 行）— `MessageBubble`（MD/TXT 切换本地 state 独立持有）
- `rows/thinking-row.tsx`（67 行）— `ThinkingBubble`
- `rows/tool-row.tsx`（133 行）— `ToolStartRow`（含 ExitPlanMode 特殊渲染）+ `ToolEndRow`（含 ImageRead 缩略图卡片）
- `rows/simple-row.tsx`（18 行）— `SimpleRow`（兜底）

总计 744 行（vs 旧 695 行，多 49 行 = imports 块 ×8 + 模块边界 jsdoc + race 修复 5 行）。

**保持不变（避免回归）**：
- `eventKey()` 函数原样搬到 `format.ts`，CHANGELOG_18 #3 修过的 row 键稳定性逻辑不能改
- 每条 `MessageBubble` / `ThinkingBubble` 独立持有 `mode` state（CHANGELOG_3 / 34 / 35 演进 3 轮的取舍）
- 容器 `<ol>` 的 `select-text` className 保留（覆盖全局 user-select: none，让用户能复制对话）
- pending-rows 仍是兄弟目录，不并入 activity-feed/（PendingTab 也在用）
- `ActivityRow` dispatcher 留在容器（避免 prop drilling，10 个 props 不再到处穿）
- 不抽公共 row 基类（4 类 row 接口 / 状态 / 渲染各异）

### `src/renderer/components/activity-feed/index.tsx` — 顺手补初始化 race（隐藏第 7 项）

旧 `ActivityFeed.tsx:74-87` 的初始化 `useEffect` 调 `listEvents` + `listAdapterPending` 无 aborted flag，切会话快时旧会话的 then 回调可能在新会话 useEffect 重跑后仍执行 `setRecent` / `setPending`，把旧会话事件灌进新会话 `recentEventsBySession`。`setSessions` 的 prune 间接缓冲了 orphan，但 race 窗口里 UI 仍会闪一次错数据。

新 `index.tsx:48-72` 加 `let aborted = false` + cleanup `return () => { aborted = true }`，两个 then 回调顶部 `if (aborted) return;`。0 性能开销。

### `src/renderer/components/SessionDetail.tsx:7`

- `import { ActivityFeed } from './ActivityFeed'` → `from './activity-feed'`（仅此一处调用点）

## 备注

### 6 候选对抗评估结论（不再做的 5 个 + 触发条件）

| # | 候选 | 三态裁决 | 不做的理由 / 未来触发条件 |
|---|---|---|---|
| 1 | adapter 公共层抽取（claude-code/sdk-bridge.ts 1100行 + codex-cli/sdk-bridge.ts 494行） | ❌×2 | 真共性 5-15%，两次 review 都说"异构但成立"是结构性事实（Claude 有 hook 通道 + 3 组 pending 状态机 + timer，Codex 刻意无权限 / 无 tool tracking）。**未来同时改两边 bridge 时再顺手抽 leaf util**（消息大小校验 / 首条 prompt 校验 / interrupt 包装），**绝不抽 BaseSession / 状态机** |
| 2 | IPC handler 按主题拆文件（src/main/ipc.ts 543 行 / 42 handler / 8 主题） | ⚠️×2 | 单人维护无 merge conflict 收益；`SettingsSet` 是「即改即生效中转点」（CLAUDE.md），拆散后单点审计变差，新设置项更易漏分发。**当 ipc.ts 涨到 800+ 行 + 出现多处并行 merge conflict 时再做**，且 `SettingsSet` 必须留根文件 |
| 3 | useIpcWithSequence hook（renderer 4 处 race 模式） | ❌+⚠️ | 4 处不同质：HistoryPanel = sequence-only / SummaryView = aborted-only / SessionDetail = 复杂特例（含 file-changed 订阅 + 节流 + selection 保留）/ pending-rows = 异质（action busy 防重复提交，不是 stale 覆盖）。**未来再出现 2-3 个同 latest-only 模式时只抽小 primitive `useLatestAsyncGate`，不抽高阶 hook** |
| 5 | events 加 generated column + 索引 | ❌×2 | 现状不是全表扫，已先按 `session_id` 限定 + `kind='message'` LIMIT 1，已有 `(session_id, ts DESC)` 索引；Layer 2 fallback 是 LLM 失败时低频走，summary 并发受 `summaryMaxConcurrent` 节流。**先 profile（统计 Layer 2 触发率 + 单次耗时），再考虑更轻方案：复合索引 `(session_id, kind, ts DESC)`** |
| 6 | summaryMaxConcurrent 暴露 UI | ⚪ 已实现 | `SettingsDialog.tsx:246-265` 已有 NumberInput（1-10）；`summarizer.ts:75-80` 每轮动态读；`ipc.ts:150-153` 注释明示天生即时生效。**从 backlog 删** |

### 风险红线（双方一致，未来动手前回查）

- 不要把 Claude / Codex bridge 强抽公共状态机
- 不要把 `SettingsSet` 分散到多个 IPC 子文件
- 不要在没有 profile 的情况下上 generated column / 新 migration
- 不要用泛化 hook 抹平 `SessionDetail` 与 `PendingTab/pending-rows` 这种不同语义

### 为什么不建 REVIEW_3.md

本次工作是「优化候选评估 + 单点拆分」，不是 BUG review。按 CLAUDE.md 边界：ActivityFeed 拆分是组织 / 复用调整，去 changelog/ 不去 reviews/。两轮 REVIEW（main + renderer 周边）刚做完，再开 REVIEW_3 短期 ROI 极低。

### Agent 踩坑沉淀

无新候选。本次双对抗结果再次验证「Claude 倾向把任意未做防御标 HIGH，未先检查项目设计取舍与现实触发路径」（REVIEW_2 同模式，已在 conventions-tally 累计中）。
