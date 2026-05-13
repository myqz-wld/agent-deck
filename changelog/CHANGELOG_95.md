# CHANGELOG_95: UX 微调六项 — hand-off 显式触发 + detail header 风格统一 + 接力按钮挪到 Composer 右下 + ActivityFeed 工具描述补齐 + deep-code-review SKILL 改 check_reply 非阻塞 poll + 加 lead nudge 兜底

**触发**：用户连续六条反馈，连发即落地（不走对抗，六条都是局部 UX 偏好微调或文档同步，不涉及业务数据 / 协议变更）。

## 概要

CHANGELOG_93 K3 hand-off UI 上线后用户连续五条 UX 反馈一次性落地，跟 detail header / Composer / dialog / activity-feed describer / deep-code-review SKILL 五处协同：

1. **hand-off 按钮加显式确认**（反馈 1）：HandOffPreviewDialog mount 后**不再**自动调 sonnet 总结，改成显示「✨ 开始总结」CTA 按钮，用户点了才调；避免 hover / 误点 modal 后立即烧一次 sonnet API
2. **TeamDetail 「← 返回」按钮挪到右上角**（反馈 2）：与 SessionDetail header 「←」按钮位置统一；与 actions 槽（关闭 N 个 teammate / 归档）共组在右侧，标题居左占 flex-1
3. **SessionDetail 「📤」按钮从 header 挪到 ComposerSdk 右下角**（反馈 3）：原右上角与 「←」挤在一起且按钮分组语义不同（破坏性 hand-off vs 安全返回），现在挪到 ComposerSdk 底部 button group 中断按钮左侧（与「中断 / 发送」次要操作组共组），label 由单 emoji 「📤」 升级 「📤 接力」让标签可读
4. **ActivityFeed 工具调用补全描述**（反馈 4）：activity-feed/describe.ts `describeToolInput` 缺 TodoWrite / WebSearch / WebFetch case，导致截图中「mcp__agent-deck__spawn_session」等连续调用纯名无摘要；CHANGELOG_94 §B1 加的 5 case 在 SessionCard 不共用，本次同步过来
5. **deep-code-review SKILL 改用 check_reply 非阻塞 poll**（反馈 5）：原 Step 2/4/5 用 `wait_reply` 阻塞 30min hard cap，lead 期间完全不收 user 追加反馈；改成 `check_reply({message_id})` + `ScheduleWakeup({delaySeconds: 60-180})` 自我调度循环 poll，让 user 看 SessionDetail 实时活动想插话「跳过 X」/「优先看 Y」时 lead 能及时响应
6. **SKILL 加 lead 自己 nudge teammate 兜底段**（反馈 6）：用户追问「check_reply 会给对方发 prompt 吗，主要怕有 teammate 会忘记」—— 答：不会。`check_reply` 是纯非阻塞 poll，不像 `wait_reply` 带 `nudge_text + nudge_after_ms` 自动催 reply 字段。如果 teammate 忘了 `reply_message`（context 满 / 卡审批 / 协议遗忘），lead 单纯 poll 永远拿不到。SKILL 加段「lead 必须自己 nudge 兜底」：5 次 poll 轻量 nudge（send_message 短提醒）/ 10 次 poll 走 get_session lastEventAt 检查 + 失败兜底 / 30min 上限到必须 abort 该 reviewer

## 变更内容

### 反馈 1: HandOffPreviewDialog 改显式触发（`src/renderer/components/HandOffPreviewDialog.tsx`）

- mount useEffect: 删 `void window.api.handOffSummarize(sessionId)` 自动调用，只重置 state（summary / summarizing / hasSummarized / spawning / error）
- 新增 `hasSummarized: boolean` state 区分「未点过开始总结」vs「已总结过 / 总结中 / 失败过」三态；`idle = !hasSummarized && !summarizing && !error` 决定是否显示初始 CTA
- `startSummarize()` 函数（合并原 retrySummarize 逻辑）：用户点「✨ 开始总结」/ 失败后「重试总结」共用此函数；成功 setHasSummarized(true) 切到 textarea 编辑态
- `disposed` 局部 closure flag → 提升为 `disposedRef = useRef(false)`（多次 startSummarize 调用共享同一个信号，避免每次重建闭包）
- 文案：说明文案明示「单次会调用 sonnet API，按 token 计费」让用户知道 cost；CTA 按钮 `bg-status-working/30` 与提交按钮同色系暗示「主操作」
- textarea 仅在 `hasSummarized || summarizing || error` 时渲染（idle 态隐藏，减少视觉噪音）

### 反馈 2: TeamDetail Header 重排（`src/renderer/components/TeamDetail/Header.tsx`）

- 「← 返回」button 从 header 左侧挪到右侧，与 actions 共组在 `<div className="ml-2 flex shrink-0 items-center gap-1.5">` 内
- 视觉降级 `text-[11px]` 文字按钮 → `flex h-5 w-5 items-center justify-center rounded text-[11px]` 方按钮 emoji-only（与 SessionDetail `←` 按钮 className 完全一致）
- 标题区 `flex-1 truncate` 直接占据剩余空间，左右两端都不再被「← 返回」打断

### 反馈 3: SessionDetail header `📤` 移除 + ComposerSdk 加按钮

#### `src/renderer/components/SessionDetail/index.tsx`

- header 右侧 button group 内的 `{isSdk && <button>📤</button>}` 整段删除，仅保留「←」返回按钮
- ComposerSdk 调用加 `onHandOff={() => setHandOffOpen(true)}` callback prop（HandOffPreviewDialog 渲染位置 + open state 仍由 SessionDetail 持有，保持 Dialog 在 detail container 内做 absolute inset-0 定位）

#### `src/renderer/components/SessionDetail/ComposerSdk.tsx`

- props 加 `onHandOff?: () => void`（可选 prop，CLI 路径走 CliFooter 不会传）
- 底部 button group 内 `<div className="flex-1" />` spacer 之后、「中断」按钮之前插入「📤 接力」按钮：
  - className 与「中断」按钮镜像 `h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10`（无主色，避免抢「发送」的蓝色焦点）
  - title 沿用 CHANGELOG_93 详细 tooltip「📤 接力到新会话：LLM 总结当前会话历史 → 起新 session（cwd / agent / 权限模式沿用）+ 自动归档原会话」

### 反馈 4: ActivityFeed 工具调用补全描述（`src/renderer/components/activity-feed/describe.ts`）

`describeToolInput` 新增 3 case 用 SessionCard `summariseToolInput` 同源逻辑（不抽公共 helper：SessionCard 是 SessionList live activity 单行用、本处是 ActivityFeed 详情 + SimpleRow 用，两处形态接近但 SessionCard 还在 LOC 拆分边界，抽 helper 要 refactor SessionCard 逆向；YAGNI）：

- `TodoWrite`：`[N/M done] · activeForm`（done 数 + 当前 in_progress 摘要 40 字）
- `WebSearch`：`"query"` 截 50 字
- `WebFetch`：url 截 60 字

新 case 注释引用本 CHANGELOG + 与 SessionCard summariseToolInput 同源逻辑，加在 `Skill` case 之前（按字母 / 频次混排）。原 default 分支 `isImageTool` 不动；mcp__* 工具暂不通用 fallback（plan 在 U5 tally：未来按需 +1 通用字段扫描器）。

### 反馈 5: deep-code-review SKILL 改 check_reply 非阻塞 poll（`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`）

- 文档标题前置「**前提**」段：把「wait_reply 按 messageId 锚点」改成「**check_reply 非阻塞 poll** 按 messageId 锚点」
- 执行模板 §Step 2: 「`Promise.all` 两个 `wait_reply({timeout_ms: 1_800_000})`」→「**非阻塞 poll**：lead 自己在循环里调 `check_reply({message_id})` × 两个 reviewer，未到则 `ScheduleWakeup({delaySeconds: 60-180, prompt: <继续本 SKILL>, reason})` 自我调度下次 wake，醒来再 check —— **两个 reviewer 都收到 reply 后**才进 Step 3。**不要用 wait_reply** 阻塞 lead」
- 执行模板 §Step 4: 反驳轮 `wait_reply({message_id: <send 返回的 messageId>})` → 「**同 Step 2 一样用 check_reply 非阻塞 poll**」
- 执行模板 §Step 5: 下一轮 `wait_reply` → 「check_reply 非阻塞 poll」
- 新加节「**为什么 check_reply 非阻塞而非 wait_reply 阻塞**」（设计取舍 3 条）：
  - lead 必须保持对 user 响应能力（30min review 期间 user 看 UI 实时活动可能想插话「跳过 X」/「优先看 Y」/「先 abort reviewer-codex」）
  - poll 节奏由 lead 自己控（≤ 5min 内 prompt cache 不失效避免每次 wake 重读全 context）
  - Bash sleep 不替代 ScheduleWakeup（sleep 仍阻塞 lead 整个 turn 不接受 user input）
- §失败兜底表 `wait_reply 超时` 行 → `check_reply 持续返回 {reply: null}` 行（recipe：检查 `get_session().lastEventAt` 是否仍推进 → 是 → 加大 `delaySeconds` 降频继续 poll）

### 反馈 6: SKILL 加「lead 必须自己 nudge 兜底」段（同文件，紧接「为什么 check_reply」之后）

用户追问揭穿盲点：`check_reply` 不像 `wait_reply` 带 `nudge_text + nudge_after_ms` 自动催 reply 字段；teammate 忘了 `reply_message` 时 lead 单纯 poll 永远拿不到。新加段三层 tactic：

- **轻量 nudge（5 次 poll / 5min 仍 `{reply: null}`）**：lead `send_message` 给 teammate 发短提醒（如「📍 nudge: 我在等你 reply 上一条 review request（msg `<前 8 字>`），完成后请用 `mcp__agent_deck__reply_message({reply_to_message_id, text})` 回我；进度需要更多时间也请回一句告知」）。新 send 的 `messageId` **不替换**原 wait 的 message_id，nudge 仅 push teammate 注意，原 reply 仍按原 message_id 配对
- **重 nudge / 升级（10 次 poll / 15min 仍无 reply）**：调 `get_session(teammateSid).lastEventAt` 看 teammate 是否还在动 → 在动 → 加大 `delaySeconds` 降频继续；不动 → 走 §失败兜底 recipe（PendingTab 真人介入 / shutdown 重 spawn / 合规兜底）
- **绝不无限 poll**：30min 上限到了仍无 reply 必须 abort 该 reviewer，不要让 lead 死循环消耗 context

## 决策（不走对抗的依据）

| 反馈 | 性质 | 不走对抗依据 |
|------|------|--------------|
| 反馈 1 显式触发 | 用户偏好，cost 收紧 | 不涉及业务逻辑改动；改前后行为差仅是「mount → IPC」vs「点击 → IPC」一行差；Q4 双阶段 IPC 设计本就为编辑预留 modal，加确认是同方向加固而非反向 |
| 反馈 2 Header 重排 | 视觉布局微调 | 与 SessionDetail header 已有 className 镜像，复用同款样式；无新组件 / 无新 IPC |
| 反馈 3 「📤」挪位 | 视觉布局 + 一次重命名 | 旧位置（header 右上）与「← 返回」语义冲突（hand-off 是破坏性，返回是无害），用户反馈即视觉分组合理性问题；新位置在 ComposerSdk 底部「中断 / 发送」次要操作群中是同语义分组 |
| 反馈 4 describer 补 case | trivial 文档 / 描述补齐 | 复用 SessionCard 已有 case 同源逻辑，0 业务 / 0 协议变更 |
| 反馈 5 SKILL check_reply | 文档 / 流程更新 | 用户已明确指示（「我是想让他用 check_reply」），且应用 CLAUDE.md `§check_reply` 节本就给设计意图（lead 期间能响应 user input），SKILL 是单点纯文档应用 |
| 反馈 6 SKILL nudge 兜底 | 文档补盲点 | 反馈 5 改完后用户立刻追问 nudge 是否会自动 push teammate（user CLAUDE.md `§check_reply` 节没明说这一点，是 SKILL 应用层必须补的兜底约束）；属于反馈 5 同主题增补，不独立走对抗 |

## 已知踩坑

- **`hasSummarized` 必须新增 state，不能用 `summary !== ''` 替代**：用户在 idle 态点取消再重开 dialog，summary 被重置为 ''，但 LLM 调用是否发生过的语义跟 textarea 内容不同步（用户可能编辑后清空 textarea，仍属「已总结」态）；用独立 boolean 不耦合
- **`requestSeqRef` 而非 `disposedRef`（review 后修正）**：见下方 §Review 后修复 HIGH-1。原 disposedRef 单 boolean 方案在 useEffect cleanup 设 true 后新 effect body 立刻置回 false → 旧 IPC resolve 仍能通过 guard 污染新 sessionId 的 state。改成 sequence counter `++req` + 闭包捕获 `cur` + sessionId capture 双护栏
- **ComposerSdk `onHandOff?` 可选**：现 CLI 路径走 CliFooter（不渲染 ComposerSdk），但这步守门是「未来 CLI 也加 hand-off 时不需要改 SessionDetail」的弹性留痕。如果未来 CLI 也加 hand-off，给 CliFooter 也加同款 prop 即可
- **HandOffPreviewDialog 不动 IPC 协议**：双阶段 IPC（SessionHandOffSummarize / SessionHandOffSpawn）保持不变；本次仅 renderer 触发时机改变，main 端 0 改动
- **不加 settings toggle 控制是否要确认**：YAGNI；按钮触发 vs 自动触发只是单次行为差，没必要全局开关
- **describeToolInput 与 SessionCard summariseToolInput 双轨维护**：U5 tally 已记，未来加新 case 必须双处同步；如出现第三处 describer 再考虑抽公共 helper
- **mcp__* 工具暂不通用 fallback**：截图反馈源自 `mcp__agent-deck__spawn_session` 但本次未加通用 mcp__* 字段扫描器（一是 spawn_session 现状靠 `team_name` / `cwd-basename` 取摘要不够通用，二是 mcp 工具入参形态变化大需要 case-by-case；后续按需 +1 case 跟踪 U5 计数）
- **SKILL `wait_reply` 残留语义只在文档警告**：本次只改 SKILL.md 文档，没改任何 source code；未来 lead Claude 按文档跑就会用 check_reply。如有 lead 仍误用 wait_reply（被「Promise.all 阻塞 wait」直觉拖回），靠 SKILL 新加节「**不要被本能反带回 wait_reply**」+ 失败兜底重写为 check_reply 兜底
- **SKILL 文档 `mcp__agent_deck__*` 7 tool 数字过时**：现状 backend 是 10 tool（含 archive_plan / start_next_session / check_reply）；本次只改 wait→check 不修这个数字漂移（属纯文档维护性更新跟反馈 5 不直接相关，留作下次专门 review）

## 测试

- `pnpm typecheck` 双端通过
- 视觉验证留 dev smoke（CHANGELOG_93 同模式 LLM 真调 + 起新 session 用户场景验证；本次仅 mount 时机调整不影响 IPC 路径）
- ActivityFeed describer 改造：纯函数 case 增补，依赖类型校验兜底
- SKILL.md 改造：纯文档，由后续 lead Claude 按新文档跑时验证

## 关联

- **CHANGELOG_93**：K3 hand-off UI 落地的本体；本 CHANGELOG 是 K3 上线后用户使用反馈的微调收口
- **CHANGELOG_94 §B1**：SessionCard summariseToolInput 5 case（TodoWrite / WebSearch / WebFetch / Task / Agent）的本体；本次反馈 4 把其中 3 case 同步到 ActivityFeed describer
- **`conventions/tally.md`** U3 / U4 / U5 / U6：本五条反馈记四条 tally；count < 3 静默累计待后续反馈推进
- **user CLAUDE.md `§check_reply` 节**：反馈 5 改 SKILL 的设计依据 SSOT
- **应用 CLAUDE.md `§check_reply 非阻塞 poll` 节** (`resources/claude-config/CLAUDE.md:62-64`)：check_reply 工具的协议本体 SSOT —— 「lead 自己控 poll 节奏」是来自这里，不是 user CLAUDE.md（user CLAUDE.md 通篇无 check_reply 字样）
- **review 后修复（reviewer-claude H1 + reviewer-codex MED1/MED2 + 6 余项）**：见下方「## Review 后修复」节

## Review 后修复（双 Bash 单次决策对抗：Claude Opus 4.7 xhigh × Codex gpt-5.5 xhigh）

按 `~/.claude/CLAUDE.md` §决策对抗 主路径走双 Bash 起外部 CLI 异构对抗 + 三态裁决，并发跑两个 reviewer 后所有 ✅ 真问题一次性修完。

### ✅ 真问题（共 9 条 / 全部修复）

#### HIGH-1: HandOffPreviewDialog disposedRef regression（双方独立）

**根因**：原方案 `disposedRef = useRef(false)` 在 useEffect cleanup 里设 true，但**新 effect body 第一行又置回 false** —— 旧 IPC resolve 仍能通过 `if (disposedRef.current) return` guard。SessionDetail 没加 `key={session.id}` → sessionId 切换时同一 dialog 实例复用，`handOffOpen` 状态保留 → in-flight IPC1 (sessionA) 在 sessionB 上 setSummary 污染。

**修法**：替换为 `requestSeqRef = useRef(0)` sequence counter + `capturedSid = sessionId` 闭包捕获双护栏。每次 startSummarize ++req + 闭包记 cur 值；resolve 时校验 `cur !== requestSeqRef.current || capturedSid !== sessionId` 即过期 IPC 静默 drop。useEffect cleanup 也 ++req 让 unmount/重开后所有 in-flight IPC 失效。

**验证**：reviewer-codex 用 `node -e` 实测复现旧 disposedRef 模式过期 resolve 通过 guard。

#### HIGH-2: SKILL nudge 与 wire prefix 协议冲突（reviewer-codex 新发现 + 实测）

**根因**：watcher 自动给 nudge body 注入 `[from <name> @ <adapter>][msg <nudgeId>]\n` wire prefix（`universal-message-watcher.ts:189-199`）。按 `reviewer-{claude,codex}.md` 协议 teammate 强制 regex 抓收到消息**第一个** `[msg ...]` 当 reply_to_message_id → teammate 会 reply nudgeId 而非原 originalId → lead 仅 poll originalId 永远拿不到 reply。

**修法**：SKILL.md 「lead 必须自己 nudge 兜底」节重写为 codex 推荐方案 A（lead 同时 poll 两个 messageId）。lead `send_message` nudge 后必须**记下 nudgeMessageId**，之后顺序 `check_reply(originalId)` + `check_reply(nudgeMessageId)`，任一非 null 即算 reply 到。下一轮（Step 5）lead 用 `send_message` 发新 prompt 时新 messageId 重新成为「当前 wait 锚点」，旧 originalId / nudgeMessageId 自动作废。

**验证**：reviewer-codex 实读 `universal-message-watcher.ts:199` + `reviewer-claude.md:36-39` + `reviewer-codex.md:41-44` + `check.ts:46-48` + `helpers.ts:166-169` 全证据链。

#### MED-1: HandOffPreviewDialog `idle` 派生缺 `spawning` 项（reviewer-claude 状态机推演）

**根因**：原 `idle = !hasSummarized && !summarizing && !error`。路径「summarize 失败 → 用户手写 textarea 兜底 → 点起新会话」时 submit 内 `setError(null) + setSpawning(true)` → 状态变成 `(false, false, null, true)` → idle=true → CTA「✨ 开始总结」按钮闪现 + textarea 因 cond `(hasSummarized || summarizing || error)` 全 falsy 而 unmount → 用户输入虽在 state 里仍存活但视觉消失。

**修法**：`idle = !hasSummarized && !summarizing && !error && !spawning` + textarea cond 加 `|| spawning`。spawn 时 textarea 保持渲染。

#### MED-2: SKILL ScheduleWakeup 工具用法超出 /loop dynamic mode 作用域（reviewer-claude *未验证* + 现场验证）

**根因**：`ScheduleWakeup` 工具描述明确「Schedule when to resume work in **/loop dynamic mode**」，本 SKILL 是通过 Skill tool 触发非 /loop 上下文，自定义占位 `<继续本 SKILL>` 既不是真 /loop 输入也不是 sentinel。

**修法**：SKILL.md 改成 **user-driven poll** 模式 —— lead 不主动 schedule wake，依赖 user 触发 poll。reviewer SDK 会话的 events 实时推送到 SessionDetail UI，user 看 UI 自己判断 reviewer 进度（reply 来了主动 ping「继续」/ 卡了主动 ping「卡了吗」/ 想插话直接说）。lead 每次 turn 开头先调 `check_reply` 一遍，有 reply 接 Step 3，没 reply 处理 user message。新加节明示：「**严禁** wait_reply（30min 阻塞 user）、`ScheduleWakeup`（仅 /loop dynamic mode 适用）、Bash sleep（阻塞 lead 整个 turn）」。

**好处**：零依赖额外 timer 工具，零浪费空 poll，符合 GUI 应用 + user-in-the-loop 工作流。

#### MED-3: SKILL nudge 阈值与 poll 节奏不自洽（reviewer-claude 算术验证）

**根因**：原阈值「5 次 / 5min」「10 次 / 15min」假设 60-90s poll 节奏；180s 上限下 5 次 = 15min 直接撞第二阈值。

**修法**：user-driven poll 改造后阈值条件改成「user 主动 ping 触发 + 累计时间」组合（不再绑定固定 poll 间隔），具体阈值表述简化为「user 连发 ≥ 2-3 次进度询问 + lastEventAt 没动 ≥ 15min」自然可读。30min 上限按 `lastEventAt` 判定。

#### MED-4: CHANGELOG_95 §check_reply 节 SSOT 归属错（reviewer-claude H2）

**根因**：CHANGELOG_95 反馈 5 决策行 + 关联节都引用「user CLAUDE.md §check_reply 节」—— 实际 user CLAUDE.md 通篇无 `check_reply` 字样，真正 SSOT 在 app CLAUDE.md `resources/claude-config/CLAUDE.md:62-64`「### check_reply 非阻塞 poll」节。SKILL.md 顶部 SSOT pointer 自身也明确指向应用 CLAUDE.md，原 CHANGELOG 文案与 SKILL 自相矛盾。

**修法**：CHANGELOG_95 line 85 决策表行 / 关联节列表第 4 项均改成「应用 CLAUDE.md `§check_reply` 节」。

#### LOW-1: TodoWrite null 数组元素 TypeError（reviewer-codex 实测复现）

**根因**：`describe.ts` TodoWrite case 只校验 `Array.isArray(o.todos)`，元素为 null 时 `t.status === 'completed'` 抛 `TypeError: Cannot read properties of null (reading 'status')`。

**修法**：`Array.isArray` 后 + `filter((t) => t !== null && typeof t === 'object')` 守门，类型断言改成 type guard `(t): t is { status?, activeForm? } => ...`。

#### LOW-2: SKILL.md 7→10 tool 数字漂移（双方一致 + 自承）

**根因**：SKILL.md line 10 写「`mcp__agent_deck__*` 7 个 tool 编排」，应用 CLAUDE.md line 32 SSOT 写「10 tool」（含 archive_plan / start_next_session / check_reply 等），`src/main/agent-deck-mcp/types.ts:51-62` 实际导出 10 个 tool name。

**修法**：SKILL.md line 10「7 个 tool」→「10 个 tool」。

#### LOW-3: HandOffPreviewDialog 注释半句话截断（reviewer-claude）

**根因**：原 line 66 `// hasSummarized 不切 true：失败后 textarea 仍允许手动写兜底，但「重试总结」按钮要在` 句末截断。

**修法**：补全为「失败后 textarea 仍允许手动写兜底；error 触发 textarea 渲染 + 「重试总结」按钮 inline 显示」。

### ❌ 反驳 / ❓ 未验证

无（反驳 0 / 未验证全部经实测 / 文档对照升级为 ✅）。

### 验证

- `pnpm typecheck` 双端通过（review 前 + review 修复后两次跑）
- reviewer-claude / reviewer-codex 双方独立 finding，HIGH-1 + LOW-2 双方一致；HIGH-2 + LOW-1 codex 单方但有实测铁证；MED-1/2/3/4 + LOW-3 claude 单方但状态机 / 文档对照可现场复核

## 关联补 tally

新加 P32 candidate 候选（reviewer-claude H1 + reviewer-codex MED1 双方独立指出的反模式）：

- **P32**: useEffect cleanup `disposedRef.current = true` + 新 effect body 立刻置回 false 的「ref guard 自动失效」反模式 —— 看似比 closure 局部 `let disposed = false` 更优雅（共享多次异步调用），实则丢了「per-effect 隔离」语义；任何 effect 重跑（含 props 变化触发）都让旧 in-flight IPC 又能通过 guard。预防：异步 IPC 取消用 sequence counter（`++req` + 闭包捕获 cur）或闭包局部 `let disposed = false`，**不要**用单 boolean ref；如必须用 ref 且 effect 会重跑，至少加「校验 props 关键 id 仍是触发 IPC 时锁定的值」第二道护栏
