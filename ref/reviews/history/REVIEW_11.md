---
review_id: 11
reviewed_at: 2026-04-29
expired: false
skipped_expired:
---

# REVIEW_11: ExitPlanMode + permissionMode 周边四 bug 双对抗

## 触发场景

用户首次试用 CHANGELOG_34 落地的「批准 ExitPlanMode + 4 档目标权限模式」打包版本，连续报出 4 条独立但同属 ExitPlanMode / permissionMode 周边的 bug：

1. **Bug 1 (HIGH)** — approve-bypass 冷切路径仍弹「⚠ [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use」红字（REVIEW_9 D' 修法漏第二条通道）
2. **Bug 2 (HIGH)** — 会话进入 plan mode 后，会话详情面板权限模式显示器没刷新（卡在切前的值）
3. **Bug 3 (HIGH)** — ExitPlanMode 询问选「保持 Plan 模式」（不切档），实际行为变成默认权限（下次 edit 弹普通 PreToolUse 询问框，而非 4 档 ExitPlanMode 框）
4. **Bug 4 (MED)** — default 模式下 Read 等只读工具也被拦审核（按设计 read-only 工具任何模式都不该拦）

四条 bug 都是协议级 / 状态机级 hazard，单方修法风险高，全部走双异构对抗诊断。

## 方法

**双异构配对**（按 `~/.claude/CLAUDE.md`「决策对抗」节）：

| 任务 | Agent A | Agent B |
|---|---|---|
| Bug 1 | Opus 4.7 xhigh subagent (general-purpose, 实读 sdk-bridge.ts + 现场反推文本指纹) | Codex CLI gpt-5.5 xhigh `read-only --skip-git-repo-check`，5 分钟超时，stdin 喂 prompt + `-o OUT` 抓最终答案 |
| Bug 2/3 | Opus 4.7 xhigh subagent（同上配置，扩 11 个文件清单） | Codex CLI gpt-5.5 xhigh（顺带核 Bug 4），独立 prompt 不带 Opus 结论防锚定 |
| Bug 4 | （快速核）应用层 grep canUseTool 注册路径 + SDK d.ts canUseTool 文档 | Codex 同 prompt 顺带核（白名单工具集与 SDK 行为无冲突） |

**范围**：

```text
src/main/adapters/claude-code/sdk-bridge.ts （核心：translate result 分支 + canUseTool resolver + ExitPlanMode resolver + respondExitPlanMode + closeSession）
src/main/ipc.ts （SessionSetPermissionMode 路由 + DB 写顺序）
src/shared/types.ts （ExitPlanModeResponse 类型）
src/renderer/components/pending-rows/index.tsx （UI 4 档 select + 按钮文案）
src/renderer/components/SessionDetail.tsx （permissionMode 显示器）
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts （SDKSystemMessage / SDKStatusMessage 类型）
```

**机器可读范围**（File-level Review Expiry 用；按字典序去重）：

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/ipc.ts
src/renderer/components/pending-rows/index.tsx
```

**约束**：跳过 CHANGELOG 1-34 已修过的部分；输出格式三态裁决 + 文件:行号 + 代码片段；不依赖 SDK 错误字符串匹配（CLAUDE.md P12 教训）；不接管全局 uncaughtException；最小修法但不能为「最小」绕过协议正确性。

## 三态裁决结果

### ✅ 真问题（Bug 1）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 1.1 | HIGH | `src/main/adapters/claude-code/sdk-bridge.ts:1581-1594` | translate `result` 分支无差别 emit ⚠ 红字，与 `expectedClose` 防护**不在同一通道**。CLI 收到 deny+interrupt:true 后**不抛异常**，而是合法地推一条 `is_error=true` 的 `result` SDK message（payload 典型为 `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`）；`for await` 顺利消费 → `translate()` 进 result 分支 → 直 emit 红字。catch 块（D' 防护所在地）根本没进，`expectedClose` gate 完全失效。**文本指纹证据**：用户截图红字无「SDK 流中断：」前缀，精确匹配 line 1592 模板 `⚠ ${detail}`，否定 catch 路径。 | ✅ | ✅ |

### ✅ 真问题（Bug 2）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 2.1 | HIGH | `src/main/adapters/claude-code/sdk-bridge.ts:1596` (`// type === 'system' 等忽略`) | translate() 末尾直接丢弃所有 `system` 消息，但 SDK 的 `SDKSystemMessage{subtype:'init', permissionMode}` 与 `SDKStatusMessage{subtype:'status', permissionMode?}` 是 **CLI 内部真实运行态的权威上行**：凡 CLI 自己翻 mode（典型：approve ExitPlanMode 后 CLI 自动退出 plan、resume 时 jsonl 与 DB mode 不一致、外部 settings 改 mode）都靠它们告知。结果：DB 留旧值、不 emit upsert、store sessions Map 不变、详情面板 dropdown 卡旧值。 | ✅ | ✅ |
| 2.2 | MED | `src/main/ipc.ts:466-470` | `await adapter.setPermissionMode` 先于 DB 写 + emit upsert。SDK 调用抛错时（典型：Query 已 close 命中 sdk-bridge.ts:1148 throw 'session not found'）跳过 DB 写 + emit upsert，store 与 DB 不一致，UI 与 SDK 真实态长期分裂。 | ✅ | (Codex 未明确点出，但其修法范式与 Opus 一致)|

### ✅ 真问题（Bug 3）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 3.1 | HIGH | `src/main/adapters/claude-code/sdk-bridge.ts:311-320`（resolver） + `:855` (post-resolver `setPermissionMode('plan')`) | ExitPlanMode resolver 对**所有** `approve` 分支都返回 `{behavior:'allow'}`。Claude Code SDK / CLI 把「ExitPlanMode 工具被 allow」**语义性视为「用户同意退出 plan」**，CLI 内部状态机立刻翻出 plan；line 855 兜底 `setPermissionMode('plan')` 跑在 CLI 已退档之后属于 CHANGELOG_47 同病灶（post-allow 时序静默吞档）。结果：UI 标签写「保持 Plan 模式」实际行为是退到 default，下次 edit 走普通 PreToolUse 询问框（而非 4 档 ExitPlanMode 框），实测复现一致。 | ✅ | ✅ |

### ✅ 真问题（Bug 4）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 4.1 | MED | `src/main/adapters/claude-code/sdk-bridge.ts:213+` (canUseTool 注册) | SDK 0.2.x 设计：注册 `canUseTool` 后，CLI 把所有工具调用决策都丢给应用（包括 Read / Grep / Glob / LS / WebFetch / WebSearch / TodoWrite / NotebookRead 这些只读 / 元数据类工具）。应用 canUseTool 实现里只有 AskUserQuestion + ExitPlanMode 两条特殊路径，剩下所有工具都走 line 371 的「emit permission-request 让 UI 弹询问」通道。**缺一个 read-only 工具白名单** → default mode 下用户被无害操作反复弹询问。 | (核) | ✅ |

### ❌ 反驳

| 报项方 | 报项 | 反驳依据 |
|---|---|---|
| Bug 1 假说 A/D（ref 不一致 / fork rename 错乱） | Bug 1 红字来自 NEW SDK 实例 | `sdk-bridge.ts:consume(...,internal)` 闭包持有同一对象，rename 只换 Map key 不换 object；resolver 拿的 `s = sessions.get(sessionId)` 与 catch 拿的 `internal` 是同一引用 |
| Bug 1 假说 B（时序错位） | flag 设置晚于 SDK 抛错 | line 846-850 先 `s.expectedClose=true` **同步**再 `entry.resolver(response)`，SDK 处理 deny 必在下一 microtask 之后 |
| Bug 1 假说 C（NEW SDK 抛错） | 红字来自 NEW SDK 的 catch 块 | NEW 的 `internal.expectedClose` 默认 false，若 NEW catch 抛错 UI 会先看到「SDK 流中断：」前缀；用户截图不带该前缀 |
| Bug 2 假说 B/E（renderer 没监听 / 用本地 state） | 显示器没读 store | `use-event-bridge.ts:22-33` listener 完整 → `upsertSession` set 新 Map；`SessionDetail.tsx:352` `useSessionStore((s)=>s.sessions.get(sessionId))`，无本地缓存 |
| Bug 2 假说 D（独立字段） | UI 读错字段 | schema v004 单列 `permission_mode` + `parsePermissionMode` 白名单含 `'plan'`；DB 与 UI 都走该字段 |
| Bug 3 假说 F（误调 setPermissionMode('default')） | 「保持 plan」分支调成 default | line 855 直接传 `response.targetMode='plan'`，无 default 误映射 |
| Bug 3 假说 I（DB normalize） | DB 写回时 'plan' 被 normalize | `session-repo.ts:174` 是裸 UPDATE，无 normalize |
| Bug 3 假说 J（hook 拦） | plan 靠 hook 拦 edit | plan 是 SDK canUseTool 层拦 mutation，agent-deck 自身的 hook 也没拦 edit/write |
| Bug 4 假说 L（SDK 自己应过滤） | SDK 端 bug | SDK d.ts 文档明确：`canUseTool? Custom permission handler. Called before each tool execution`，决定权完全归应用 |
| Bug 4 假说 M（PreToolUse hook 注入到 SDK 决策） | hook matcher='*' 把 read-only 也注 | `hook-installer.ts:124-129` 只是安装外部 hook，不会生成 SDK permission request |

### ⚠️ 部分

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| Bug 3 假说 G（SDK 静默吞 plan） | post-allow 时序确实吞档（CHANGELOG_47 同病灶） | 本仓库无法证伪，但修法不应依赖它 | 部分成立。真正的协议根因是 H（approve+plan 走 allow 本就语义错），G 是 H 引出的次生现象，**修 H 即可，不依赖 G** |
| Bug 3 修法（approve+plan 改 deny+message） | 让 CLI 留 plan 通过 message 告 Claude | 同方案，但**警告 message 文案要避免 plan→deny→plan 死循环** | 双方一致采纳 deny+message；message 文案明确「不要在本会话内立刻再次调用 ExitPlanMode」防循环 |
| Bug 2 修法（main / renderer 边界） | 主因 + 次因都修（translate 加 system 分支 + ipc 顺序错位回滚） | 只主因（translate 加 system 分支） | 本轮全收：主因修 + 次因 hardening 一起做（与 `restartWithPermissionMode` 内部范式对齐，统一收口） |

## 修复（review 内直接落地，不新建 changelog）

### HIGH

1. **`src/main/adapters/claude-code/sdk-bridge.ts:1590` (Bug 1)** — translate result 分支 emit 红字加 `&& !internal.expectedClose` gate；同时把「⚠ SDK 流中断」前缀逻辑沉淀到注释明示这是 D' 修法漏的第二条通道（覆盖 approve-bypass 冷切 / closeSession / 应用退出三入口）

2. **`src/main/adapters/claude-code/sdk-bridge.ts:1596 → 替换 system msg 处理分支` (Bug 2 主因)** — translate 末尾的 `// type === 'system' 等忽略` 改成 `else if (msg.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'status') && typeof msg.permissionMode === 'string')` 分支，inline 校验 4 档白名单后比 DB 不同再 `sessionRepo.setPermissionMode + eventBus.emit('session-upserted', updated)`

3. **`src/main/adapters/claude-code/sdk-bridge.ts:311-320` (Bug 3 主因)** — resolver `approve + targetMode === 'plan'` 单独走 `{behavior:'deny', message:'用户已认可你的计划，但要求你继续在 plan 模式下推进...不要在本会话内立刻再次调用 ExitPlanMode...', interrupt:false}`；`approve + targetMode ∈ {default, acceptEdits}` 才走原 allow 分支

4. **`src/main/adapters/claude-code/sdk-bridge.ts:855` (Bug 3 守卫)** — `respondExitPlanMode` 内 approve 分支顶部加 `if (response.targetMode === 'plan') return;` 守卫；plan 分支什么都不动（DB 已是 plan，CLI 也仍在 plan）

### MED

5. **`src/main/ipc.ts:466-470` (Bug 2 次因)** — `SessionSetPermissionMode` handler 把 DB 写 + emit upsert **提到** `await adapter.setPermissionMode` 之前 + try/catch SDK 调用，失败时回滚 DB 到 oldMode + emit upsert + 重抛（与 `restartWithPermissionMode` 内部范式一致）

6. **`src/main/adapters/claude-code/sdk-bridge.ts:51-70 + 213+` (Bug 4)** — 文件顶部新增 `READ_ONLY_TOOLS = new Set(['Read','Grep','Glob','LS','WebFetch','WebSearch','TodoWrite','NotebookRead'])` 常量；`canUseTool` resolver 顶部（AskUserQuestion / ExitPlanMode 特殊路径之前）加 `if (READ_ONLY_TOOLS.has(toolName) || toolName.endsWith('__ImageRead')) return { behavior: 'allow', updatedInput: input };`

## 关联 changelog

无（本轮全部在 reviews/ 内直接落地，无新功能；Bug 3 修法虽然「让原本就该如此的行为生效」改变了用户感知，但 UI 标签「保持 Plan 模式」字面意思未变，README 措辞「批准 plan 时可选目标权限模式（默认 / 自动接受编辑 / 保持 Plan / 完全免询问）」依然准确，README 不动）

## Agent 踩坑沉淀

本次 review 提炼出 2 条 agent-pitfall 候选，写入 `.claude/conventions-tally.md`「Agent 踩坑候选」section：

1. **「双通道防护」陷阱** — 给 SDK 错误加 expectedClose 之类的 gate 时，必须同时 gate **catch 通道**（throw / abort / cleanup）和 **frame 通道**（SDK 自己合法推 is_error message 然后正常关流）。只 gate 一边 = 防护漏一半。CHANGELOG_34 D' 修法只 gate catch，REVIEW_11 Bug 1 补 frame 通道。
2. **「allow = 同意退出」语义陷阱** — SDK 工具协议中「allow」是「批准这次工具调用」，但某些工具（典型 ExitPlanMode）的语义就是「请求退出当前模式」，allow 即语义性退出。如果业务想「批准内容但保持模式」必须改用 deny+message 形式，不能依赖事后 setPermissionMode 兜底（post-allow 时序静默吞档，CHANGELOG_47 + REVIEW_11 Bug 3 双重证据）。

同主题再撞 2 次会触发升级到 CLAUDE.md「项目特定约定」节。
