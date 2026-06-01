# REVIEW_99 — resume-history 历史注入特性首次 code deep-review（3 轮异构对抗 + 反驳轮）

> 关联 plan：`ref/plans/resume-inject-raw-messages-20260601.md`（已归档；plan 仅过 Step 1.5 plan-review，**代码实施此前从未 code-review**）
> 关联 commits：`0d94640`→`7a5c75a`（特性实施，~1563 行新代码）/ `92d711c`（R1 fix）/ `88fec9b`（R2 fix）
> 性质：新特性首次 code review（debug/加固 —— 无新功能引入，归 reviews）

## 背景与诉求

用户「deep review 全项目，BUG 排查 + 代码优化」，自主推进 + 自主 hand off。项目已有 98 份 review（成熟项目），「全项目」= 锁定**最新未 review 代码**。经 churn / recency / file-level-review-expiry 自检，最大未审面 = **resume-history 历史注入特性**（commits 0d94640→7a5c75a）：plan 经 Step 1.5 deep-review，但**代码实施从未 code-review**（grep `ref/reviews/` 0 命中）。

**特性目标**：claude/codex 断连自愈走 fresh CLI/thread fallback（jsonl 丢失）时，起 fresh 进程**之前**用应用层 DB（events 表）拼「LLM 总结段 + 最近原始对话消息段 + 用户当前消息」三段结构化文本 prepend 到首条 prompt，让 Agent 不失上下文（§架构地基：拼 1 条结构化 user message 是当前 SDK 版本下唯一正解）。

## 方法

`agent-deck:deep-review` SKILL，3 轮异构对抗 + 反驳轮：
- **reviewer-claude**（claude-code adapter，Opus 4.7）`3508acbc`
- **reviewer-codex**（codex-cli adapter，gpt-5.5 xhigh）`019e8451`
- lead（本会话）三态裁决 + 全程现场验证（sqlite3 CLI repro / emit→ingest→insert 同步链 trace / clamp 边角矩阵 / 预算 invariant 手算 / LOW-2 重算）

**scope**（全在 repo root，无 sandbox cp 需求）：
- 核心：`src/main/session/resume-history/inject-history.ts`（353 行新文件）/ `src/main/store/event-repo.ts`（listRecentMessages + maxEventId）
- 集成：claude/codex `jsonl-fallback.ts` + `recover-and-send-impl.ts` × 2 / `summarizer/llm-runners.ts`
- 设置：`app-settings.ts` / `defaults.ts` / `settings-store.ts`（resumeRecentMessagesCount + autoSummariseOnFallback→REMOVED_KEYS）

## 轮次概览

| 轮 | reviewer-claude | reviewer-codex | lead 裁决 |
|---|---|---|---|
| R1 | 1 MED + 1 LOW + 1 INFO | 3 MED | 3 真问题（MED-A clamp 双方共识 / MED-C raw-drop codex+lead验 / LOW-B dup 双方机制）+ INFO-D 测试 |
| R2 | 0 HIGH/MED + 1 INFO（既有范式）+ 验证 R1 fix 全safe | **1 HIGH** + 1 LOW | HIGH（close-race）单方→反驳轮证实 / LOW（summary-only fit）codex+lead重算 |
| 反驳轮 | ❓→✅ 证实 HIGH 成立（独立读码+时序脚本+强化反例排除） | — | HIGH ✅ 收口 |
| R3 | 同意 conclude（7-case 真值表验 R2 fix）| **1 HIGH + 1 MED**（R2 fix 仍未完全收口）| **split verdict → lead 裁决 codex 正确**：R2 transition-check 自身有洞，carry-forward 到下一会话用 epoch 方案收口 |

**R3 split verdict 处理**：reviewer-claude 同意 conclude，但 reviewer-codex 抓出 R2 fix 本身 2 个残留洞（lead 全部现场验证为**真**）。**这正是异构对抗 both-agree 收口要求的价值** —— 单方 conclude 会漏审。lead 裁决：R1+R2 已修部分稳定保留（commits 92d711c/88fec9b），R3 两条 carry-forward。

## R1 三态裁决 + 修复（commit 92d711c）

两 reviewer R1 均 **0 HIGH**。

### ✅ MED-A — resumeRecentMessagesCount 无服务端 clamp（双方独立提出）
- **问题**：`SettingsSet` 只校验 sandbox union 字段，数值字段 resumeRecentMessagesCount 裸落库；UI `min={1}` 仅 renderer 软约束。负数 → SQLite `LIMIT -1` 无界拉全表 message + 全量 JSON.parse（长会话 OOM 风险）；0 → `LIMIT 0` 静默关闭注入；NaN → bind 抛错。
- **验证**：lead sqlite3 CLI 实测 `LIMIT -1`=全表 / `LIMIT 0`=空；grep 全消费链零 clamp。
- **修法**：injectResumeHistory 入口 `safeRecentCount = Math.min(200, Math.max(1, Math.floor(Number(x))||30))`（消费点覆盖所有 caller + NaN）+ eventRepo.listRecentMessages 防御层 safeLimit clamp（非 IPC caller 兜底）。

### ✅ MED-C — buildRawSegment 首条超预算 break 丢总结（codex 单方 + lead 验证）
- **问题**：最新一条历史是接近 102400 上限的 paste/log 时，`buildRawSegment` 第一轮即 `used+cost>budget` → `break` → picked 空 → 外层 history-budget-empty 退回纯 originalText，连已生成成功的总结 + 后面能 fit 的短消息一起丢。
- **修法**：`break`→`continue`（跳过超大单条试更旧短消息）+ 新增 `raw-budget-empty-summary-used` 态（raw 全空但总结 fit 时保「总结+当前」两段）。

### ✅ LOW-B — maxEventIdBefore=null 当前消息泄漏进 raw（双方 flag 机制）
- **问题**：recover 路径 session 0 历史时 maxEventId 返 null → beforeId=undefined → 不加边界查最近 N → 入口刚 emit 的当前消息（emit→ingest→insert 全同步已落库）被 raw 段查到 → 与末段重复。
- **验证**：lead 确认 `ctx.emit`→`sessionManager.ingest`→`persistEventRow`→`eventRepo.insert` 全同步（better-sqlite3）；sqlite3 repro 当前消息泄漏。
- **修法**：recover 两端 caller `() => maxEventIdBefore ?? 0`（id<=0 命中空集走 no-history）；restart 路径 `()=>null` 不受影响（handoffPrompt 不入口 emit）。event-repo jsdoc 删失实「caller 去重末条」措辞。

### INFO-D — 测试补全
inject-history +6 case（clamp×4 / continue / summary-preserve）+ event-repo clamp×3 防御回归。

## R2 三态裁决 + 修复（commit 88fec9b）

### ✅ HIGH — close-during-summary-await 复活 closed 会话（codex 单方 → 反驳轮双方共识）
- **问题**：recover 路径 `await injectResumeHistory`（summariseFn LLM oneshot 10-30s）期间用户主动 close → closeImpl 调 adapter.closeSession（fresh CLI 未起，sessions Map 无 live internal → index.ts:384 early-return no-op）+ setLifecycle('closed')，但**不 abort 在途 recovering promise / 不加黑名单**。await resolve 后 createSession 起 fresh CLI → 首条 SDK 事件过 ensure（manager.ts:266 `closed && archivedAt===null && source==='sdk'`）→ **复活成 active**，静默反转用户显式 close + 起多余 fresh CLI（按次计费）。
- **验证链**：
  - lead 全链 trace：closeImpl(lifecycle.ts:131-157) 调 adapter.closeSession 后 setLifecycle('closed') 不动 recovering（grep 确认 recovering 仅 recoverer finally / restart-controller 清）；index.ts:384 no-internal early-return；ensure(manager.ts:266) revive 三条件。
  - **反驳轮 reviewer-claude 独立证实**：从 ❓ 转 ✅，自认 R2 focus③ 漏审（只看 scheduler 衰减没看用户主动 close），独立读码两环节 + 时序脚本 `/tmp/r2-close-race.mjs` 复现，强化反例排除（close 走 closeImpl 不经黑名单 → 「isRecentlyDeleted 兜底拦 revive」反例不成立）。
- **严重度**：codex 判 HIGH（后果重：用户意图反转 + 多余计费），claude 判 MED（低频：需恰在 10-30s 窗口 close）。lead 裁决 **HIGH（低触发频率注记）** —— 违反 CLAUDE.md「resume 优先 / 用户意图」核心不变量，修法成本低，值得修。
- **修法**：recover caller 传 `isCancelledFn`，helper 在 `await injectResumeHistory` 后、`createSession` 前重读 → abort 返 `aborted:true`，caller 优先于 fellBack/fall-through 判定直接 return 静默结束（不起 fresh / 不 emit / lifecycle 已是用户想要的 closed 无需回滚）。**关键设计**：检测「await 期间新 close」**transition**（`r.lifecycle==='closed' && !wasClosed`）而非绝对 closed 态 —— 入口就 closed 的合法 resume（REVIEW_76/81 用户主动 resume 已关闭会话应复活）不能误 abort。restart 路径不传 isCancelledFn → 不 gate（本就先 close 再 cold restart）。两端对称。
- **测试反捕设计缺陷**：初版 isCancelledFn 用绝对 closed 态 → 误 abort 6 个「入口就 closed 的合法 resume」集成测试 → 改 transition 检测修正（验证了测试网的价值）。

### ✅ LOW — summary-only fit 边界误丢总结（codex 单方 + lead 重算）
- **问题**：raw 全超预算时 step4 复用预扣 rawWrapperCost 的 includeSummary 判定（过度保守）。`summaryCost===budgetForHistory` 边界时 includeSummary=false（严格 `<`），但 summary-only prompt（summaryCost+currentBlock，不含 raw wrapper）可能仍 ≤ maxLength → 误丢能 fit 的总结。
- **验证**：lead 重算确证（rawWrapperCost=38 / summaryWrapperCost=55；142<142 false 但 162≤200 能 fit）。
- **修法**：raw 空时**重判** summary-only fit（`summaryCost + currentBlock.length <= maxLength`）。

### 回归测试
jsonl-fallback +3（close-abort / 未close正常起 / restart不gate）+ inject-history +2（summary-only边界保住 / 也装不下退originalText）。typecheck 双绿 + 178 tests 全过。

## lead 独立验证为安全（focus 逐项，非 finding）

- **预算超长 / off-by-one**：手算 + reviewer-claude 实测六档，三段拼接 prompt.length ≤ maxLength−1 < maxLength 恒成立；continue 改动后 invariant 仍 hold（continue 比 break 更安全，只能加约束满足项）。
- **降级链永不抛错**：除 original-over-length 唯一阻塞态，所有 thunk（maxEventIdFn/listMessagesFn/listEventsFn/summariseFn）try/catch 兜住。
- **maxEventId TOCTOU**：捕获→emit→recovering.set 全程同步无 await，JS 单线程无交错窗口。
- **lifecycle during await**：events 在 await 前同步快照；summariseFn oneshot `settingSources:[]` 不读 lifecycle/不写 DB；rec 快照 + single-flight 串行化。
- **cross-adapter parity**：prependCwd 两端实际值恒 = rec.cwd（等价）；agentName 'Claude'/'Agent' 仅文案差异。

## Follow-up（不阻塞本特性收口）

- **[INFO] json_valid guard 缺失**（reviewer-claude R2）：listRecentMessages / findLatestAssistantMessage / hasToolUseStartWithFilePath 用 `json_extract` 无 `json_valid` 前置 guard，malformed JSON 行致整查 throw（非 per-row skip）。**既有 codebase 范式**（非本特性引入）+ 写入侧 safeStringifyPayload 无 malformed 可达路径 + 即使触发被 injectResumeHistory step1 try/catch 兜成 no-history（永不阻塞不变量仍守住）。建议单开 follow-up plan 统一为这批 `json_extract` 查询加 `json_valid(payload_json) AND` 前置 guard。

## ⚠️ R3 carry-forward —— close-race 收口未完成（下一会话用 epoch 方案修）

R3 reviewer-codex 抓出 R2 transition-check fix（commit 88fec9b）**本身有残留洞**，lead 全部现场验证为**真**。R2 的 `wasClosed` lifecycle-snapshot 方案根因不可靠，需改 **cancellation epoch** 方案。**这两条尚未修复**：

### [HIGH 未修] wasClosed 基线漏「恢复期间第二次 close」
- **链路**：① session 入口就 closed（合法 resume）→ `wasClosed=true`（入口 emit **之前**捕获）② 入口 `emit(source:'sdk')` 必经 ensure（manager.ts:266）revive closed→active（**dedupOrClaim 所有 skip 分支 gate 在 source==='hook'，source:'sdk' 入口 user message 永不 skip → 必到 ensure revive** —— lead 已验证）③ await injectResumeHistory 期间用户**再次** close → DB 回 closed ④ `isCancelledFn: closed && !wasClosed` = `closed && !true` = false → 不 abort → createSession 反转第二次 close。
- **根因**：`wasClosed` 在入口 emit **之前**捕获，但入口 emit 本身会 revive → `wasClosed` 是错误基线。
- **位置**：claude/codex `recover-and-send-impl.ts` isCancelledFn thunk（88fec9b 引入）。

### [MED 未修] post-guard 窗口（createSession 内 sessions.set 前）
- **链路**：R2 guard 只在 `await injectResumeHistory` 后、`ctx.createSession` 前查一次。进 createSession 后到 `deps.sessions.set(internal.applicationSid, internal)`（create-session-sdk-query.ts:143）之间还有 await（loadSdk L74 / buildMcpServersForSession L97）→ 这段窗口用户 close 仍 no-op（sessions Map 无 internal）→ 同款 revive。codex 端 create-session-impl.ts:85 对称。
- **根因**：与 HIGH 同根 —— lifecycle 快照无法可靠检测「recovery 期间发生过 close」。

### 修复方案（下一会话实施）：cancellation epoch
- `closeImpl` / `markClosedImpl`（lifecycle.ts）对每个 session 自增一个 **close-epoch 计数器**（内存 Map<sid, number> 或复用某已有结构）。
- recovery 入口 **emit user message 之后** 捕获 `epochAtEntry = getCloseEpoch(sid)`（注意：必须在 emit 后，因 emit 触发 revive 不算 close）。
- helper 在 `createSession` 前检查 `getCloseEpoch(sid) !== epochAtEntry` → abort（替代现 isCancelledFn 的 lifecycle 快照）。
- **MED 收口**：epoch 检查需再传入 createSession，在 `sessions.set` 前（pre-registration awaits 后）再查一次；或更稳 —— sessions.set 后立即补查一次 epoch，变了则立即 closeSession 自己。
- **绕开两个陷阱**：① 不依赖 lifecycle 快照（entry-emit revive 不影响 epoch）② mock-vs-reality gap 消失（epoch 是显式信号，测试可直接 mock getCloseEpoch 返不同值模拟 close）。
- **测试**：需覆盖「入口就 closed 的合法 resume（epoch 不变 → 不 abort）」+「await 中途首次/二次 close（epoch 变 → abort）」+「post-guard 窗口 close（sessions.set 前后 epoch 变 → abort/自关）」。

> R3 详细 finding + 修复推理链 + reviewer-codex 补充意见见接力文件 `.claude/plans/deep-review-project-rolling-20260602.md`。reviewer 对（teamId 591cd6f2）未 shutdown，下一会话可 send_message resume 复用 mental model 继续收口。

## 收口状态

**Batch 1 部分收口**：R1（3 finding）+ R2（1 HIGH + 1 LOW）已修 + 测试（commits 92d711c / 88fec9b，178 tests 全过 + typecheck 双绿）。**R3 carry-forward 未收口**：close-race 残留 1 HIGH + 1 MED（R2 transition-check 自身洞），需下一会话用 cancellation epoch 方案专门修复 + 双 reviewer 重新 conclude 共识。**本 REVIEW 暂不算最终收口**（双 reviewer 未达成 conclude 共识 —— reviewer-codex R3 明确不同意）。

