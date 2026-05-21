---
plan_id: codex-stream-error-classify-20260521
created_at: 2026-05-21T08:50:00+08:00
completed_at: 2026-05-21T17:05:00+08:00
status: completed
base_commit: 30574d5d2df090220242a056e16e9c4193fe0c9e
base_branch: main
worktree_path: null  # 轻 plan 不进 worktree（用户 RFC 第 3 问选项）
---

# Codex 流级错误三态识别 — translate.ts 修法

## 背景与症状

用户报告 codex CLI 接入两个症状：

1. **发送消息后很久才会处理到这个消息，好像没有打断的机制**
2. **经常出现「⚠ Codex 流级错误：Reconnecting... 1/5 (stream disconnected before completion: ...peak load... Provisioned Throughput.)」但实际还是在工作**

### 根因诊断

**症状 1**（架构内禀，本 plan 不修）：
- claude-code SDK 用 `query({prompt: AsyncIterable<SDKUserMessage>})` streaming input
  通道，新消息 push + notify 立刻进 SDK 上下文（即使工具调用中也能接收）
- codex SDK 用 `thread.runStreamed(input)` turn-based，1 个 input → 1 个 turn，必须
  等 turn 跑完才能下一轮 `while (pendingMessages > 0)` 循环（铁证：thread-loop.ts:210-341）
- 结果：codex 长 turn 期间发新消息 = 排队等 turn 结束。codex SDK 升级到提供 streaming
  input API 之前应用层无解。**应用层能做的最多是用户主动按「中断」按钮 abort 当前
  turn 让队列下一条立刻起，但会丢当前 turn 进度**。本 plan 不展开

**症状 2**（应用层翻译契约 bug，本 plan 主修）：
- `src/main/adapters/codex-cli/translate.ts:73-77` 把 codex CLI 自身的 5 次内置重连
  中间状态错误地翻译为 `finished:error` 让 UI 状态机误以为 turn 结束
- 铁证（`strings $codex_binary | grep -iE "reconnect|disconnect|retr|max retry"`）：
  - 中间态字面：`Reconnecting... `、`stream disconnected before completion: `、
    `stream disconnected - retrying sampling request `、`reconnecting: `
  - 终态字面：`max retry times reached`
- codex SDK d.ts 注释（dist/index.d.ts:158-162）说 `ThreadErrorEvent` 是
  `unrecoverable error`，但 codex CLI 实际行为是用它通知 recoverable 中间态。
  **协议契约 vs 实际行为不一致**，应用层必须识别区分

### 症状 2 → 症状 1 的连带效应

修了症状 2 后，症状 1 的体感也会改善：
- 修前：reconnect 期间应用 emit finished:error → UI bubble 状态机以为 turn 结束
  → 用户体感「卡住 + 突然报错 + 又恢复」混乱
- 修后：reconnect 期间应用 emit info message 不带 error，turn 不结束 → UI 状态条
  仍显示 working → 用户体感「在重连，等下」清晰

## 不变量

1. **不吞真错误**：白名单 + 启发式漏匹配的真错误仍走 finished:error 路径，不静默丢
2. **不重复 finished**：单次 turn 内 finished 只 emit 一次（中间态绝不 emit finished；
   终态显式 emit）
3. **wire format / DB 子表 invariant 不变**：本次仅改 translate 层，不动
   sdk-bridge / sessionManager / DB
4. **error: true flag 仅用于真错误**：中间态 emit message 不带 `error: true` flag
   （让 UI 不显示红字 / 不计入 PendingTab）
5. **协议向前兼容**：codex SDK / CLI 升级后即使 `ThreadErrorEvent.message` 字面变
   化，启发式层（regex 含 `retry`/`reconnect`/`disconnect`）仍能兜底

## 设计决策

> RFC 第 1 轮三个问题 + 用户回答（2026-05-21）

### D1. 识别策略 = 白名单 + 启发式双层（RFC Q1）

**优先白名单严格匹配**：
- `Reconnecting...`（含尾随 ` 1/5`）
- `stream disconnected before completion`
- `stream disconnected - retrying sampling request`
- `reconnecting:`（小写带冒号）
- `app-server event stream disconnected`（codex 内部 console.warn 也可能透到 message）
- `TCP Connection with remote is closed, trying to reconnect`

**未命中白名单 → 启发式 regex 兜底**：`/(retr|reconnect|disconnect)/i`
- 含 `retry / retrying / retried / reconnect / reconnecting / disconnect / disconnected`
  任一关键字均当中间态
- 漏匹配（如 codex 升级后用 `connection lost - falling back` 不含上述关键字）→
  console.warn 帮诊断 + 仍按原路径 emit finished:error，不吞真错

**终态显式识别**：
- 白名单字面：`max retry times reached`
- regex：`/(max\s+retr|exhaust|gave\s+up)/i` 兜底
- 命中终态 → emit message(error: true) + finished(ok:false, error)
- 既不命中中间态白名单也不命中终态白名单 + 启发式判定中间态 → 走中间态路径
- 既不命中中间态也不命中启发式 → 走终态路径（保守）

> 不变量 1 「不吞真错误」直接对应：默认走终态保守，仅明确识别为 recoverable 才弱化

### D2. UI 呈现 = 显示重连进度，不带 error 红字（RFC Q2）

中间态 emit 一条 message：
```ts
emit('message', { text: `🔄 Codex 正在重连... ${progressLabel}` });
```

**进度数字提取**（best-effort）：
- 解析 `event.message` 看是否含 `1/5` / `2/5` 类「N/M」结构
- 用 regex `/(\d+)\s*\/\s*(\d+)/` 提取
- 提取到 → `progressLabel = "重连尝试 N/M"`
- 提取不到 → `progressLabel = ''`（仅显示「Codex 正在重连...」）

**注意**：codex CLI 实际格式可能是 `Reconnecting... ` 带 trailing 空格 + 别处带计数器，
具体格式以实测为准。提取失败不阻塞中间态识别（progressLabel 空仍输出）。

**不 emit finished**：让 UI 状态条仍显示 working，turn 真结束（next turn.completed
或 max retry 终态）才 emit finished。

### D3. 不引入新 AgentEvent kind（保守扩展）

不加 `'reconnect'` / `'transient-error'` 这类新 kind。理由：
- 新增 kind 影响面：renderer store / UI bubble 渲染 / IPC 序列化 / 子表
  `events.kind` enum / SQLite migration / 跨 adapter parity（claude 是否对称引入？）
- 当前痛点是「显示错误用了 error 红字」，message kind + 文案区分足够解决
- future-proof：如果未来需要 reconnect 进度条 UI 组件再加 kind 也不晚（YAGNI）

### D4. 测试矩阵

新增单测覆盖（`src/main/adapters/codex-cli/__tests__/translate.test.ts`）：

| Case | 输入 message | 期望 events |
|---|---|---|
| 1 | `Reconnecting... ` | 1 条 message（`🔄 Codex 正在重连...`），不带 error，无 finished |
| 2 | `Reconnecting... 1/5 (stream disconnected before completion: ...)` | 1 条 message（`🔄 ... 重连尝试 1/5`），不带 error，无 finished |
| 3 | `stream disconnected - retrying sampling request (responseStreamDisconnected)` | 1 条 message，不带 error，无 finished |
| 4 | `Some random retry attempt notice` | 启发式命中 → 1 条 message，不带 error，无 finished + console.warn |
| 5 | `JSON parse failed` | 原行为：1 条 message(error: true) + 1 条 finished(error)（更新原 case 不破坏） |
| 6 | `max retry times reached` | 1 条 message(error: true) + 1 条 finished(error) |
| 7 | `connection lost - falling back to ...`（启发式不命中 — 故意构造无 retry/reconnect/disconnect 词） | 走终态：1 条 message(error: true) + 1 条 finished(error)（保守） |

> Case 4 / 7 锁住「白名单不命中 → 启发式兜底」与「启发式也不命中 → 保守走终态」分支
> Case 6 / 7 锁住「真终态不被吞」（不变量 1）

## 步骤 checklist

- [x] Step 0 — RFC 第 1 轮（识别策略 / UI 呈现 / 工程流程）
- [x] Step 1 — 写 plan 文件（本文件）
- [x] Step 2 — 改 `src/main/adapters/codex-cli/translate.ts`：
  - [x] 抽 helper `classifyStreamErrorEvent(message: string): 'transient' | 'fatal'`
  - [x] 抽 helper `extractRetryProgress(message: string): string`（best-effort `N/M` 提取）
  - [x] case 'error' 改：classify → transient 走 message no error + 不 emit finished；
        fatal 走原 message+finished 路径
- [x] Step 3 — 改 / 新增单测（D4 表 7 个 case），保 case 5 原 regression
- [x] Step 4 — `pnpm typecheck` + `pnpm exec vitest run translate.test.ts`（30/30 pass）
- [x] Step 5 — 异构对抗 review（reviewer-claude HIGH×3 / MED×4 / LOW×1，reviewer-codex HIGH×1 / MED×1 / LOW×1，双方独立 HIGH-1/HIGH-3 + claude 单方 HIGH-2 + claude 单方 MED-2/MED-3 + codex 单方 MED-1）
- [x] Step 6 — fix review finding：
  - [x] HIGH-1: STREAM_ERROR_HEURISTIC_RE 改 word-boundary `\b(retry|retrying|retried|reconnect|reconnecting|reconnected|disconnect|disconnected|disconnecting)\b`
  - [x] HIGH-1: FATAL_STREAM_ERROR_PHRASES 扩 12 条 codex binary 实测真 fatal 字面（凭证 / API / 网络 / exec-server / 配置 / 编码 / 重传 / 重试用尽）
  - [x] HIGH-2: STREAM_ERROR_FATAL_RE 加 `exceeded\s+retr` + `maximum\s+retr`
  - [x] HIGH-3: extractRetryProgress regex 加 transient 关键词锚点
  - [x] MED-1（codex 单方）: classifyStreamErrorEvent 启发式命中 console.warn
  - [x] MED-2（claude 单方）: 测试 C8-C12 真 fatal regression
  - [x] MED-3（claude 单方）: 测试 C13 日期前缀边角 + C4 增 console.warn 验证
  - [x] MED-1-claude（*未验证*）: §已知踩坑 补 watchdog backlog
  - [x] MED-4（*未验证*）: D1 注释加 *未验证* 标
  - [x] 重跑 typecheck + 36 测试 pass
- [x] Step 7 — commit + 写 CHANGELOG_140
- [x] Step 8 — plan 归档（mv → `<main-repo>/plans/`，frontmatter status=completed）

## 当前进度

完成。本次单会话 close-out。

## 已知踩坑

- codex CLI 升级（如从 0.131 → 0.140+）可能改 ThreadErrorEvent.message 字面 →
  白名单失效。启发式层（D1）+ console.warn（D1 漏匹配条）兜底，发现漏匹配再补
  白名单
- `runStreamed` 真挂（codex 子进程 exit / SDK 抛错）走 thread-loop.ts:313 catch 分支
  emit finished，不经 translate 'error' case。本 plan 不动这条路径
- 单测 mock event 不能 100% 覆盖真实 codex CLI 实际 emit 字面 — 用户提供的实际报错
  日志（`Reconnecting... 1/5 (stream disconnected before completion: ...)`）是最权威实
  测样本，case 1 / 2 必须基于这条日志构造
- **MED-1-claude *未验证* backlog**（reviewer-claude R1 提出，无现场实证）：
  极端边角下 codex CLI 既不进程崩也不发后续事件（如内部死锁 / TCP 半挂 / 客户端
  bug），thread-loop while loop 卡在 `for await ev of events`，**transient 路径 emit
  message 不 emit finished → turn 永远 stuck**。当前依赖「codex CLI 5 次重试用尽必
  发 max retry 终态字面」假设（本 plan HIGH-1/HIGH-2 修法已强化 fatal 识别）。
  如未来出 codex CLI 死锁报告，应用层可加 watchdog timer（如 5min idle no-event
  abort current turn）兜底；当前先靠用户主动按「中断」按钮收口
- **MED-4-claude *未验证*** （reviewer-claude R1 提出）：translate.ts D1 决策树注释
  「步骤 1 在 2-3 之前是因为 codex 实际报文常含 disconnect 词 + max retry 词组合」
  当前未实证，可能 codex CLI 是发**两条独立 ThreadErrorEvent**（先 transient × 5，
  最后 fatal 单条）。fatal 优先策略两种情形下都正确（拼接走 fatal / 独立两条各走
  各的），但注释陈述无现场 evidence — D1 修改后注释已带保守措辞

## 下一会话第一步

如果跨会话接力（罕见，本 plan 应能单会话完成）：
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/codex-stream-error-classify-20260521.md`
2. 不进 worktree（轻 plan，base_branch=main 直接改）
3. 看「步骤 checklist」打勾位置接续；当前 Step 2 实施
