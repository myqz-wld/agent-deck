---
plan_id: "resume-inject-raw-messages-20260601"
created_at: "2026-06-01T18:30:00+08:00"
status: "completed"
base_commit: "6084f7d9d99d0fc9afa18752a7d97a438e4f3c56"
base_branch: "main"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/resume-inject-raw-messages-20260601"
final_commit: "4713300f3827e031c54e12df3ee5b281be65e054"
completed_at: "2026-06-01"
---
# Plan: resume/fallback 注入 DB 真实历史消息（总结 + 最近 N 条原始对话）

## 总目标

升级「丢消息的 resume」——jsonl-missing fallback 起 fresh CLI/thread 时，除了现有 LLM 总结，**额外注入应用内 DB（events 表）的最近 N 条原始对话消息**，让 Claude/Codex 续聊时不只看到压缩总结，还能看到原始上下文细节。

覆盖 **claude jsonl-missing fallback** + **codex fallback**（codex 现在完全不注入，本 plan 一并接上）。hand_off_session 不动（baton 单向交接，注入对话历史不符合其语义——用户已确认预期内）。

## 背景（为什么做）

- 现状：claude `prependHistorySummary` 只注入 LLM 再压缩的 ≤4000 字总结；codex `maybeCodexJsonlFallback` 啥都不注入（REVIEW_60 F5 待办，卡在「`prependHistorySummary` 耦合 claude `MAX_MESSAGE_LENGTH` + `summariseCodexSessionForHandOff` 签名不同」）。
- 本会话从 SQLite 还原丢失会话 `facb8f92` 上下文的经历本身就是反例：总结丢了「完成≠收口」的真相。原始消息比总结更可靠。

## 架构地基（spike 源码铁证，不再争论）

**核心结论**（spike4 codex 源码调查 + spike1-3 实测，详 `<plan-id>/spike-reports/`）：**当前 SDK 版本下，传 app DB 文本历史给新会话的唯一正确做法 = 拼 1 条结构化 user message**（`[历史回顾]\n用户:...\n助手:...` + 当前消息）。两端（claude/codex）对称。

走过的弯路（已被源码证伪，**禁止**再尝试）：
- ❌ `SDKUserMessage.shouldQuery:false` 逐条 append —— **SDK wrapper 源码 0 实现**（`sdk.mjs` 0 命中），CLI/协议未兑现类型注释语义。实测 `num_turns=0` 静默 no-op（spike1/2 共 5 变体）
- ❌ 多条 AsyncIterable message —— 是**实时多轮输入流**（每条独立 user turn），不是历史注入；中间历史会丢（spike3b 实测旺财不见）
- ❌ `SDKUserMessageReplay` —— SDKMessage **输出**联合类型，非 `query()` **输入**接受类型
- ✅ raw JSONL transcript 在时可走 `resume + sessionStore` —— 但本 plan 场景 jsonl 已丢（正是触发原因），用不了 → 落到「拼 1 条结构化文本」

102_400 单条上限是真实物理约束但**低频**（30 条对话扣总结约占 95900 预算，平均每条 ≤3196 字符即 fit），降级链（D6）/ 预算式拼接（不变量 6）是**边界兜底**非核心路径。

> ⚠️ lead 教训：不确定 SDK 行为 → 读源码 / spawn agent 读源码，**禁止**黑盒猜+试错（本会话在 shouldQuery 死字段上耗 7 变体 + 绕 3 轮 review，用户点醒「spawn codex 查」才用对方法）。

## 不变量

1. **永不阻塞 fallback 主路径**：注入任何环节失败（DB 读错 / 无历史 / LLM 总结失败 / 拼接超长）一律**分级降级**到能起来的版本（见 D6 降级链），fresh CLI/thread **必须能起来**。沿用并强化现有 `prependHistorySummary` 的「永不抛错，封装 PrependResult」契约。**这是硬不变量，不接受任何让 fresh 起不来的边界**（R1 HIGH 实测：claude createSession 无 MAX 校验会无界透传 / codex `create-session-validate.ts:35` throw 阻塞——两端都不能裸放超长）。**契约覆盖所有 caller**（R2 MED）：`maybeJsonlFallback` 有 3 个 caller（recoverer + restart-controller×2），共享 helper 对 `originalText > maxLength` 返显式 failReason `original-over-length`，caller 据此**不进 createSession** + emit 清晰错误（不能依赖「recoverer 入口已校验 ≤MAX」——restart-controller 传 handoffPrompt 含 plan 无 cap）。
2. **注入内容 = 总结段 + 原始消息段 + 用户当前消息**，三段顺序固定（见 §设计决策 D3）。总结段可降级缺省（D6/D7），原始消息段 + 用户当前消息是底线。
3. **不持久化**：注入内容每次 fallback 重算，不落库（低频路径，成本可接受）。沿用现状。
4. **DB events 双数据源**（R2 HIGH 修订）：`listEventsFn`（全量 events 喂总结段出 4 节结构）+ `listMessagesFn`（message-only 拼原始消息段）。都走 DB，不碰 jsonl（jsonl 已丢失正是触发本路径的原因）。
5. **两端行为对称**：claude/codex 注入同款三段结构、同款 N、同款总结（都走本地 OAuth claude oneshot，agentName 按 adapter 视角参数化——见 D8）。差异仅 adapter 视角文案。
6. **cap 安全网保留但参数化 + 预算式拼接**（R1 HIGH + R2/R3 MED 修订）：共享层接收 `maxLength` 参数（两端同传 102_400）。**原始消息段走预算式拼接**（R3 MED：固定 `RAW_MESSAGE_MAX_CHARS=4000`×30=120K 反而撑爆 102_400 → 长会话必落 tier3 no-op，伪概念）：列表从最新往旧逐条加入，累计逼近「maxLength − 总结段 − 当前消息 − wrapper」预算就停（动态条数 ≤ N，优先保最新对话），**raw 段恒 fit 预算无 raw 溢出边界**（R4：raw 不再是溢出主因；剩余边界仅「总结段单独超大」走 D6 step2 / 「当前消息+wrapper 逼近 maxLength」走 step3，均非 raw）。参数化（而非 import claude constants）达成 D9 解耦。
7. **无条件注入**（R2 MED 修订）：去掉 `autoSummariseOnFallback` 开关逻辑（UI toggle 早已删，字段保留 default:true 当孤儿 zombie——见 `ExperimentalSection.tsx:23`）。fallback 路径无条件走注入（DB 有历史就注），删死分支 `if (!autoSummariseOnFallback)`，字段加进 `settings-store.ts REMOVED_KEYS` 清历史孤儿。

## 设计决策（RFC 三轮收敛，不再争论）

### D1 注入内容 = 总结 + 原始消息都给（RFC R1-Q1）
正常路径两者都注入新会话首条 prompt：LLM 总结（宏观脉络）+ 最近 N 条原始 role/text 消息（细节铁证）。**优先级**：原始消息段是底线，总结段可降级缺省（总结失败 / 超长时丢总结保 raw——见 D6/D7），因为「原始消息比总结更可靠」（背景节）。

### D2 覆盖路径 = claude jsonl-missing fallback + codex fallback（RFC R1-Q2）
- claude 接入点：`src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts:230` `prependHistorySummary(...)` 调用处
- codex 接入点：`src/main/adapters/codex-cli/sdk-bridge/codex-jsonl-fallback.ts:116` `createSession(...)` 之前（现在直接用 `opts.prompt`，改为先经共享层拼接）
- hand_off_session：不动

### D3 三段拼接顺序 = 总结前 / 原始消息中 / 用户当前消息后（RFC R2-Q3）
```
===== 历史会话摘要（由应用 DB 历史自动生成，因为 CLI 内部 jsonl 已丢失）=====
<LLM 总结>

===== 最近原始对话消息（应用 DB events 表）=====
[用户] <text>
[Claude/Codex] <text>
... (最近 N 条，chronological 升序；预算式拼接逐条加到逼近预算停——见 D4/不变量6；不含「用户当前消息」本身，maxEventIdBefore 排除——见 D4)

===== 用户当前消息 =====
<originalText>
```
沿用现有 `buildPrepended` 的五等号块设计（让 LLM 区分旁白上下文 vs 当前 task）。总结段超长/失败时整段缺省（D6/D7 降级），原始消息段 + 当前消息是底线。

### D4「原始消息」= 只取对话消息 + 排除当前消息（RFC R2-Q1，R2 MED 修订）
只取 `kind==='message'` 且 `role∈{user,assistant}` 且 `error!==true` 的 events。**不含** tool-use/file-changed/waiting（那些喂总结段，原始消息段要干净对话）。
- 数据来源字段：event.payload.role（'user'/'assistant'）+ event.payload.text + event.payload.error
- **排序**（R1 LOW）：message-only SQL `ORDER BY ts DESC, id DESC LIMIT N`（最新 N 条，id tie-breaker 防同毫秒逆序——REVIEW_83）；helper 内 `.reverse()` 成 chronological 升序（旧→新）拼接
- **排除当前消息**（R2 MED + R3 MED：当前 user message 在 `recover-and-send-impl.ts:154` 入口先同步 emit 落库 → fallback 查最近 N 会把它查进 raw 段 → 与 D3 末段「用户当前消息」重复 + 白占 1 slot）：用 **maxEventIdBefore 边界排除**。**maxEventId 走 helper 注入 thunk 不裸调**（R4 codex MED：REVIEW_76 同款坑——caller 在 helper 外裸调 `eventRepo.maxEventId` 抛错会穿透、绕开 helper「永不抛错」契约、阻断 fallback 让 fresh 起不来）：helper 接收 `maxEventIdFn: () => number | null` thunk，**在 helper 内 try/catch**（与 `listEventsFn`/`listMessagesFn`/`summariseFn` 同款保护），抛错降级（maxEventId 取不到 → 不加 beforeId 边界退化为「查最近 N + 文本匹配 drop 末条当前消息」兜底，仍继续 fallback）。helper 内拿到 maxEventIdBefore 后传 `listMessagesFn(sessionId, limit, beforeIdInclusive)`，SQL 加 **`AND id <= ?`**（R3 MED off-by-one：emit 前的 max id = 最后一条真实历史本身，`id < ?` 会漏掉它；`<=` 才保留「emit 前所有历史」+ 排除 emit 出的当前消息 id）
  - **新增 `eventRepo.maxEventId(sessionId)`**（R3 MED gap-1：`emit` 返 void 拿不到 insert id，且 eventRepo 无此方法 → 实施者卡住）：`SELECT MAX(id) FROM events WHERE session_id=?`（无 row 返 null）。**bind 成 helper 的 `maxEventIdFn` thunk**（R4 codex MED：异常封装在 helper 内）。caller 在 entry emit user **之前**的时机由 helper 调 thunk 捕获（thunk 闭包记 emit 前的 id —— caller 构造 thunk 时绑定「emit 前」语义）
  - **caller 数两端不对称**（R3 MED gap-3，实测纠正原「两端同款」错）：claude `maybeJsonlFallback` 有多 caller（`recover-and-send-impl.ts` + `restart-controller.ts:208/389`）；codex `maybeCodexJsonlFallback` **只 1 caller**（`recover-and-send-impl.ts:276`，codex 无 restart fallback）。Step 5/6 接线点数量据此区分
- **预算式拼接非固定截断**（R3 MED）：raw 列表从最新往旧逐条加入，累计字符逼近预算就停（见不变量 6）。**拼成 1 条结构化文本**（spike4 codex 源码铁证：shouldQuery 死字段 / 多条 AsyncIterable 是实时多轮非历史 / 中间会丢 → 拼 1 条结构化 user message 是唯一正确做法，详 §架构地基）

### D5 定量 = settings 可配 default 30 + 新增 message-only SQL 查询（RFC R2-Q1+R3-Q2，R1 MED）
- 新增 settings 字段 `resumeRecentMessagesCount`（default 30）：settings-store + types + IPC SettingsSet 分发 + 设置面板 UI（「会话」section）
- **新增 `eventRepo.listRecentMessages(sessionId, limit, beforeIdInclusive?)`**（R1 MED：`listForSession` 默认 limit=200 会被 tool-use events 占满取不到更早对话；R2 MED：加 beforeId 排除当前消息）：SQL `WHERE session_id=? AND kind='message' AND json_extract(payload_json,'$.role') IN ('user','assistant') AND (json_extract(payload_json,'$.error') IS NULL OR json_extract(payload_json,'$.error')=0) [AND id <= ?] ORDER BY ts DESC, id DESC LIMIT ?`（R3 MED off-by-one：`<=` 非 `<`，详 D4 + §已知踩坑）。直接拿正好 N 条对话，不受 raw events 密度影响
  - 参考现有 `findLatestAssistantMessage`（同款 `json_extract` role + error filter SQL 范式）
  - 共享 helper 的 `listMessagesFn` thunk bind 此新查询

### D6 cap 安全网保留 + 分级降级（R1 HIGH + R2 MED 修订）
**根因**（实测）：claude `create-session-impl.ts:56-57` 只校验空 prompt **无 MAX 校验** → 超长无界透传进 SDK；codex `create-session-validate.ts:35` 有 MAX 但 `throw` → 穿透 `codex-jsonl-fallback.ts:116`（外层无 try）→ fresh thread **起不来**。两端都不能裸放超长。

**降级链**（共享 helper 内，接收 `maxLength` = 102_400；raw 段走预算式拼接见 D4/不变量6）：
0. **前置**（R2 MED caller 契约）：`originalText.length > maxLength` → 返 `{used:false, failReason:'original-over-length'}`，**caller 不进 createSession** + emit 清晰错误（覆盖 restart-controller 传 handoffPrompt 含 plan 无 cap 的 caller，不能假设 originalText 一定 ≤MAX）
1. 拼「总结段 + 原始消息段 + 当前消息」→ ≤ maxLength：用之（`used:true`，full）
2. 超长 → 丢总结段，拼「原始消息段 + 当前消息」→ ≤ maxLength：用之（`used:true`，failReason=`over-length-dropped-summary`）。**仅在「总结段单独超大致预算≤0、raw 段为空」边界触发**（R4：预算式已扣总结，正常 full 恒 fit；step2 只在总结段 > maxLength−当前−wrapper 时救场）
3. **wrapper 边界兜底**（R4 claude MED + codex LOW 修订，**改名 + 改触发条件**）：step1/2 都不 fit 的剩余边界 = 「当前消息 + wrapper 本身逼近 maxLength」（不是 raw 撑爆——预算式后 raw 段恒 ≤ 预算 ≤ maxLength−当前−wrapper，raw 永远不是溢出主因）→ 退回纯 `originalText`（`used:false`，failReason 改 **`history-budget-empty`**，旧名 `over-length-raw-too-big` 失真）。已过 step0 → originalText ≤ maxLength → createSession 一定能起。**正常路径几乎不可达**（当前消息通常远 < maxLength），作 wrapper 边界 + 预算实现 bug 的防御兜底
- **cap 参数化而非删**：helper 接 `maxLength` 入参（caller 传各自 constants，两端同值 102_400）→ 去 claude constants 耦合（达成 D9 解耦）+ 保安全网（守不变量 1）。**不** import 任何 adapter constants
- caller 按 failReason emit 对应文案（full / 仅原始消息 / 仅当前消息 / 超长拒注 四档告知用户）

### D7 总结段 = 复用 summariseSessionForHandOff（sonnet/4节）（RFC R2-Q4 + R3-Q3，R2 HIGH 修订）
- 复用 `summariseSessionForHandOff`（sonnet，≤4000字，目标/已做/下一步/相关文件 四节结构化），**不是** summariseViaLlm（haiku 30字短）。接力场景详细总结更有用
- 模型走 `settings.handOffModel` 优先级链（本地 OAuth claude oneshot，与被总结会话哪个 adapter 无关）
- **总结段喂全量 events 非 message-only**（R2 HIGH：`formatEventsForPrompt` 消费 tool-use-start/file-changed/waiting-for-user 出「相关文件」节 + 工具活动；只喂 message-only 会让 4 节结构 silently 回归，白付 sonnet 成本）：helper 用 `listEventsFn`（全量）喂 summariseFn，与 `listMessagesFn`（message-only 拼 raw 段）**两个独立数据源**
- **总结失败不连带丢 raw**（R1 MED）：见 D6 降级链——summariseFn throw/empty 时仍拼「原始消息段 + 当前消息」（failReason=`summary-failed-raw-used`），不退纯 originalText。与「原始消息更可靠」初衷一致

### D8 codex 总结也调 claude oneshot + agentName 参数化（RFC R3-Q2，R1 MED）
- codex 端「总结段」**复用** claude oneshot（本地 OAuth）——不为 codex 写平行总结函数。解开 REVIEW_60 F5 卡住的耦合。模型由 `settings.handOffModel` 控制
- **agentName 参数化**（R1 MED：现 `summariseSessionForHandOff` 硬编码 `buildHandoffPrompt({agentName:'Claude'})`，codex 调它摘要会自称「Claude 会话」；`build-prompt.ts:55-60` 已支持 `agentName` 分支，`codex-cli/handoff-runner.ts:60` 已有 'Agent' 先例）：抽参数化 `agentName:'Claude'|'Agent'` 的 claude-oneshot handoff runner，claude fallback 传 'Claude'，codex fallback 传 'Agent'

### D9 抽 adapter 无关共享层（RFC R1-Q4，R1 INFO 确认可行，R2 修订签名）
现 `prependHistorySummary` 在 `claude-code/sdk-bridge/recoverer-helpers.ts`，唯一 claude 耦合是 `import MAX_MESSAGE_LENGTH from './constants'`。
- **抽到** `src/main/session/resume-history/`（与 summarizer 同层）
- claude 和 codex fallback 都 import 同一共享 helper
- **解耦靠 maxLength 参数化**（不删 cap，见 D6）
- 共享 helper 签名（R2 双数据源 + 去开关 + agentName；R4 codex MED maxEventIdFn thunk）：`{ sessionId, originalText, cwd, recentMessagesCount, maxLength, agentName, maxEventIdFn, summariseFn, listEventsFn, listMessagesFn }` → `PrependResult`（含分级 failReason）。**`maxEventIdFn: () => number | null`** 是 thunk 不是预算值（R4 codex MED：helper 内 try/catch 异常封装，与 summariseFn/listEventsFn/listMessagesFn 同款「永不抛错」保护）。**去掉 `autoSummariseOnFallback`**（不变量 7：无条件注入）
- helper **只拼 prompt 字符串**，不调 createSession（createSession 留各 adapter fallback 文件调，绕开两端 CreateSessionThunk 签名差异——R1 INFO 确认隔离正确）
- test seam：`summariseFn` / `listEventsFn` / `listMessagesFn` / `maxEventIdFn` 注入（走 helper 直注路径测，不依赖 TestBridge——见 §已知踩坑）

## 实施步骤 checklist

- [x] **Step 1 — 新建 adapter 无关共享层**（D9）— done 2026-06-01，`resume-history/inject-history.ts` + `index.ts`：
  - [x] 1a 签名加 `maxLength` / `agentName` / `recentMessagesCount` / `maxEventIdFn`(thunk) 参数，去 `autoSummariseOnFallback`，去 claude constants 耦合（函数改名 `injectResumeHistory`，未平移旧 `prependHistorySummary` 字面而是新写三段版）
  - [x] 1b 双数据源 `listEventsFn`(全量喂 summariseFn) + `listMessagesFn`(message-only 拼 raw 段) + 预算式 `buildRawSegment`（逐条加到逼近预算停 + reverse chronological）
  - [x] 1c D6 降级链：step0 `original-over-length` / step1 no-history / step2 `over-length-dropped-summary` / step3 `summary-failed-raw-used` / step4 `history-budget-empty`
  - [x] 1d 总结失败不连带丢 raw（`summary-failed-raw-used`）
  - [x] 1e 无条件注入（无 autoSummariseOnFallback 分支）+ maxEventIdFn / listMessagesFn / listEventsFn / summariseFn 全 helper 内 try/catch
- [x] **Step 2 — message-only repo 查询**（D5）— done 2026-06-01，`event-repo.ts` 加 `listRecentMessages(sessionId, limit, beforeIdInclusive?)` + `maxEventId(sessionId)`（SQL `kind='message'` + role IN + error filter + `[AND id <= ?]` + `ORDER BY ts DESC,id DESC LIMIT ?`）。单测留 Step 7
- [x] **Step 3 — agentName 参数化总结 runner**（D8）— done 2026-06-01，`llm-runners.ts` `summariseSessionForHandOff(cwd, events, agentName='Claude')` 加可选第三参（向后兼容所有现有 caller；codex fallback bind 'Agent'）
- [x] **Step 4 — settings 字段**（D5）— done 2026-06-01：`resumeRecentMessagesCount`(default 30) 加到 app-settings + defaults + LifecycleSection UI（「生命周期」section，min=1）。**删 `autoSummariseOnFallback`**：app-settings decl + defaults 删 + settings-store REMOVED_KEYS 加 + ExperimentalSection/AgentDeckMcpSection 注释同步。IPC 端无需 apply*（纯 get 型字段，消费侧每次 fallback 临时 settingsStore.get，patch 自动持久化）
- [x] **Step 5 — claude 接入**— done 2026-06-01：`jsonl-fallback.ts maybeJsonlFallback` 改调 `injectResumeHistory`（传 maxLength=MAX_MESSAGE_LENGTH / agentName='Claude' / recentMessagesCount=settingsStore.get / listMessagesFn / maxEventIdFn）+ `original-over-length` throw 给 caller catch（不进 createSession）。JsonlFallbackCtx 加 listMessagesFn / JsonlFallbackOptsBase 加 maxEventIdFn。index.ts 加 protected listRecentMessagesForSession wrapper + RestartController/SessionRecoverer ctor 传 listMessagesFn。recover-and-send-impl 在 entry emit user **前**固化 maxEventIdBefore + 传 `() => maxEventIdBefore`。restart-controller 2 caller 传 listMessagesFn + `maxEventIdFn: () => null`。删 recoverer-helpers.ts。测试 ctx stub 补 listMessagesFn（Step 7 补完整 case）
- [x] **Step 6 — codex 接入**（全套 thunk 链）— done 2026-06-01（**实际 +3 ctor thunk**：summariseFn + listEventsFn + listMessagesFn；maxEventIdFn 不走 ctor thunk，recover-and-send-impl 直接 eventRepo.maxEventId 在 entry emit 前固化，对称 claude）：
  - [x] 6a `recoverer.ts` ctor 5 参 → **+3**（summariseFn + listEventsFn + listMessagesFn）
  - [x] 6b `recoverer/_deps.ts` 加 4 thunk type（SummariseFnThunk/ListEventsFnThunk/ListRecentMessagesFnThunk/MaxEventIdFnThunk）
  - [x] 6c `recover-and-send-impl.ts` RecoverAndSendDeps +3 + entry emit 前固化 maxEventIdBefore + 传 `() => maxEventIdBefore`
  - [x] 6d `CodexJsonlFallbackCtx` +3 thunk / `CodexJsonlFallbackOpts` +prependCwd+maxEventIdFn
  - [x] 6e `index.ts` `new SessionRecoverer(...)` +3 实参 + 3 protected wrapper（summariseForHandOff bind `summariseSessionForHandOff(_,_,'Agent')` / listEventsForSession / listRecentMessagesForSession）+ import eventRepo+summariseSessionForHandOff
  - [x] 6f `codex-jsonl-fallback.ts` 调 `injectResumeHistory`（maxLength=MAX_MESSAGE_LENGTH/agentName='Agent'/recentMessagesCount）+ `original-over-length` throw + emit 双 builder（buildCodexJsonlMissingSummaryUsed/SkippedText 替旧 NoSummary）。codex TestBridge `_setup.ts` 加 3 override。jsdoc 同步「codex 无 LLM 摘要」→「已对称」
- [x] **Step 7 — 测试**— done 2026-06-01：
  - [x] 共享 helper 单测 `resume-history/__tests__/inject-history.test.ts`（16 it：双数据源/三段顺序/chronological reverse/agentName 前缀/maxEventIdFn 作 beforeId+null 退化/4 thunk throw 永不抛错/no-history/summary-failed-raw-used(throw+null+空)/over-length-dropped-summary/history-budget-empty/original-over-length/预算式动态条数）
  - [x] message-only repo 单测 `store/__tests__/event-repo-recent-messages.test.ts`（11 it：role/error/非message 过滤/「最近200全tool-use+更早message」/LIMIT N/id DESC tie-breaker/beforeIdInclusive off-by-one `<=`/maxEventId 最大+null/跨session 隔离）— `pnpm test` Electron-as-node binding 真跑
  - [x] claude+codex 回归全绿；helper 逻辑 bug 修复（summariseFn 返 null 现正确标 summary-failed-raw-used）
  - [x] **全套 113 文件 / 1541 测试全绿**（Electron-as-node binding 真跑无 corruption）
- [x] **Step 8 — 验证**— done 2026-06-01：typecheck + build + 全套 113 文件 / 1541 测试**三绿**（Electron-as-node binding 真跑无 corruption）。文档：`ref/changelogs/CHANGELOG_194.md` + INDEX 加行 + README「生命周期」section 加「断连恢复注入对话条数」设置项。**dev 实测两端 jsonl-missing fallback 注入效果留用户在真实 Electron 环境手动操作确认**（删 jsonl 触发 fallback）

## 当前进度

- RFC 三轮 + 补轮 + 4 spike + Deep-Review R1-R4 收敛完成（详见下方历史）
- **Step 1-8 全部实施完成（2026-06-01，worktree 内 4 commit）**：
  - 734f95d Step 1-2（共享层 injectResumeHistory + event-repo message-only 查询）
  - f95d826 Step 3-5（claude 接入 + settings 字段 + agentName 参数化）
  - 67db059 Step 6-7（codex 接入历史注入 + 全套测试，解开 REVIEW_60 F5）
  - c7d87d6 Step 8（CHANGELOG_194 + INDEX + README 设置项）
- **验证三绿**：typecheck（tsconfig.node + web 双配置）+ build（main/preload/renderer 三端）+ 全套 113 文件 / 1541 测试（Electron-as-node binding 真跑无 corruption）
- **实施期发现并修复的关键点**：
  - codex 端实际 +3 ctor thunk（非 plan 写的 +4）：maxEventIdFn 不走 ctor thunk，recover-and-send-impl 直接 `eventRepo.maxEventId` 在 entry emit 前固化（对称 claude，时机敏感）
  - helper 逻辑 bug（单测暴露）：`summariseFn` 返 **null**（非 throw）时原逻辑漏标 `summary-failed-raw-used` → 已修（hasSummary=false 即标，仍注 raw）
  - claude TestBridge 不 override listEvents/listMessages（走 eventRepo vi.mock 路径，保现有测试范式）；codex TestBridge 加 3 override（codex 测试范式走 TestBridge override）
- **待用户确认**：dev 实测两端 jsonl-missing fallback 注入效果（删 jsonl 触发）→ confirm 后走 archive_plan 收口

## RFC / Deep-Review 历史（已收口，存档）

- RFC 三轮 + 补轮 + 4 spike（query入口/streamInput/传历史/codex源码）→ 铁证锁定「拼 1 条结构化文本」唯一正确
- Deep-Review R1-R4：R1 双方独立同 HIGH（D6 删 cap 破不变量1）+ 5 MED；R2 新挖 1 HIGH（双数据源缺口）+ 4 MED；R3 新挖 2 MED（beforeId off-by-one + raw cap 不自洽）；R3 后用户质疑触发补 spike codex 源码证明唯一解；R4 终审新挖 1 MED（claude step3 dead code / codex maxEventId 破坏永不抛错契约）+ 2 LOW，全采纳

## 下一会话第一步

**状态：Step 1-8 实施 + 验证完成（typecheck/build/test 三绿 + 文档），worktree 内 4 commit。等用户 dev 实测确认 → archive_plan 收口。**

1. 若用户已 dev 实测确认两端 fallback 注入效果 OK → 走 archive_plan 收口：先 `ExitWorktree(action: "keep")` → `mcp__agent-deck__archive_plan({ planId: "resume-inject-raw-messages-20260601", worktreePath: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/resume-inject-raw-messages-20260601", baseBranch: "main", changelogId: "194" })`
2. 若用户实测发现问题 → `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/resume-inject-raw-messages-20260601)` 进 worktree 修（worktree clean，4 commit 已落；改前先 `cat` 真实文件）
3. 实测方式提示用户：dev 跑起后，对一个 dormant/closed 会话手动删其 jsonl（claude: `~/.claude/projects/<encoded-cwd>/<cli-sid>.jsonl`；codex: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<thread-id>.jsonl`）→ 在该会话发消息触发 fallback → 看 fresh CLI/thread 首条 prompt 是否含「最近原始对话消息」段 + emit「已注入历史上下文」文案


## 已知踩坑

- **传历史 = 拼 1 条结构化文本**（spike4 codex 源码铁证）：shouldQuery（SDK 0 实现）/ 多条 AsyncIterable message（实时多轮非历史，中间会丢）/ SDKUserMessageReplay（输出类型非输入）**全是死路**，禁止再试。详 §架构地基。
- **claude createSession 无 MAX 校验**（`create-session-impl.ts:56-57` 只校验空 prompt）→ 超长 prepended 会无界透传进 SDK；codex `create-session-validate.ts:35` 有 MAX 但 throw → 阻塞 fresh thread。两端都靠共享层 cap 降级链兜底（D6），**不能**依赖 createSession 自然 reject（R1 HIGH）。
- **`maybeJsonlFallback` 有多 caller**（R2 MED + R3 实测纠正）：claude = recoverer + `restart-controller.ts:208/389`（restart 传 handoffPrompt 含 plan 无 cap）；codex `maybeCodexJsonlFallback` **只 1 caller**（recoverer，codex 无 restart fallback）。共享 helper 必须 step0 校验 `originalText > maxLength` 返 `original-over-length` 让 caller 别进 createSession（覆盖所有 caller）。Step 5/6 接线点数 claude 多处 / codex 1 处，**非「两端同款」**。
- **当前 user message 重复注入 + beforeId off-by-one + maxEventId 永不抛错**（R2 MED + R3 MED + R4 codex MED）：entry `recover-and-send-impl.ts:154` 先同步 emit user 落库 → fallback 查最近 N 会含它 → 与末段重复。修：新增 `eventRepo.maxEventId(sessionId)`（`emit` 返 void 拿不到 id），**bind 成 helper 注入的 `maxEventIdFn` thunk 在 helper 内 try/catch**（R4 codex MED：caller 裸调会重蹈 REVIEW_76 坑——DB 抛错穿透阻断 fallback 让 fresh 起不来；thunk 闭包绑「emit 前」语义，抛错降级不阻塞），SQL **`AND id <= ?`**（R3 MED：`id < ?` 会漏掉 emit 前最后一条真实历史；`<=` 才保留全部历史 + 排除 emit 的当前消息）。
- **总结段需全量 events 非 message-only**（R2 HIGH）：`formatEventsForPrompt` 消费 tool-use/file-changed/waiting 出 4 节结构；只喂 message-only 会让「相关文件」节空 silently 回归。双数据源（listEventsFn 全量喂总结 + listMessagesFn message-only 拼 raw）。
- **raw 段预算式拼接非固定 cap**（R2 MED + R3 MED）：assistant 无长度上限（send-validation 只 cap 用户输入）。**禁用固定 `RAW_MESSAGE_MAX_CHARS=4000`**（R3 实算 30×4000=120K>102_400 反而撑爆 → 长会话必落 tier3 no-op，伪概念）。改预算式：列表从最新往旧逐条加入，累计逼近「maxLength − 总结段 − 当前消息 − wrapper」就停（动态条数 ≤ N，优先保最新对话，永远 fit）。
- **test seam 走 helper 直注，不依赖 TestBridge**（R1 MED 修正 ref）：claude `_setup.ts:59/184` 是 jsdoc **不是** mock；真 seam 是 `summariseOverride`（_setup.ts:63）+ `summariseForHandOff` override（_setup.ts:187）；`_setup.ts` **无 listEvents seam**。新特性测试走 `jsonl-fallback.test.ts` 已用的 ctx 直注 thunk 路径。
- **id tie-breaker**（REVIEW_83）：message-only SQL `ORDER BY ts DESC, id DESC` 内建，helper 只需 `.reverse()`。
- **codex 接入是全套 thunk 链**（R1 MED + R2 HIGH + R4 codex MED）：非「一行插入」，镜像 CHANGELOG_107 的 5 处接线点，且 **+4 thunk**（summariseFn + listEventsFn + listMessagesFn + maxEventIdFn）。
- **去 autoSummariseOnFallback 开关**（R2 MED）：UI toggle 早删（`ExperimentalSection.tsx:23`），字段保留 default:true 当孤儿。本 plan 删死分支 + REMOVED_KEYS 清孤儿，无条件注入。
