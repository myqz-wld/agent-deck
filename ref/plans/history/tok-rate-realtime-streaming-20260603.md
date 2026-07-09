---
plan_id: tok-rate-realtime-streaming-20260603
created_at: 2026-06-03T09:55:00Z
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/tok-rate-realtime-streaming-20260603
status: completed
base_commit: 9afbf68
base_branch: main
final_commit: 8961b77
completed_at: 2026-06-03T20:15:00Z
spike_reports_path: ref/plans/tok-rate-realtime-streaming-20260603/spike-reports/
---

# header 实时 tok/s（流式估算·末尾校准）+ GC wiring + DataPanel 文案 + MiniMax fixture 清理

## 总目标

header 顶栏实时显示 Top3 模型的输出 tok/s，**生成过程中实时跳动**（不是 turn 末才跳一下），顺带：
- wire 从未接的 token_usage GC（表无限增长）
- DataPanel 加「实时估算 vs 精确历史」说明文案
- 清理泄漏到测试 fixture 的真实模型 codename（MiniMax/minimax redaction artifact）

## 设计决策（不再争论）

### D1. 数据源 = 文本估算，不是精确 token delta（spike 实测锁定）

**已 spike：实证 message_delta 单发 / 假设「流式拿精确 token」推翻**（spike1 + spike3，`.claude/plans/tok-rate-realtime-spike/`）：

- Claude Agent SDK 经 `includePartialMessages: true` emit `type: 'stream_event'`，包裹 Anthropic raw SSE
- 高频源 `content_block_delta`（haiku 27ms/帧、sonnet 73ms/帧），delta.type ∈ {text_delta, thinking_delta, signature_delta}，**只带文本不带 token**（Anthropic SSE 协议定义，非 CLI 所为）
- 带 token 的 `message_delta` 被 Claude Code CLI 压成每 turn 末尾**只发 1 次**（spike3 实测长输出 4704 token/41.8s 仍只发 1 次，41819ms 才来，证明单发非短输出偶然，是 CLI 通道硬限制）
- 唯一逐包拿 token 路径 = 抛开 CLI 直连 `@anthropic-ai/sdk` raw API，但绕过本 app 全套 CLI 鉴权/session/tooling 基建，**不在范围**

**结论锁定（用户拍板 Q1=估算实时·末尾校准）**：生成中累计 text_delta+thinking_delta 字符 → 估算 token（CJK 调系数）→ 算瞬时 tok/s 高频推 UI；turn 末用权威 `result.modelUsage` snap 真值（现有链路天然完成，无需新逻辑）。

### D2. 流式估算值 ephemeral，绝不落库（双重计数结构上不可能）

text_delta 累计字符 → 估算 token → 瞬时 tok/s，**只走独立 IPC push channel（eventBus 'token-rate-tick'）给 renderer 展示**，不进 token_usage 表、不进 ingest。DB 完全不动。tick 不是 AgentEvent，绝不经 `emit: EmitFn`（那会进 ingest）；直接 `eventBus.emit`（translate 主函数已有先例：system 分支 `sdk-message-translate.ts:405` 直接 emit 'session-upserted'）。

### D3. 现有精确链路一字不动

assistant 帧采集（L250-283）+ result 帧 correction（`emitResultUsageCorrection` L362）+ DB max-merge + daily/topToday 全保留。实时估算是纯叠加旁路。

### D4. tok/s 恒为 0 的真因 = 本方案顺带根治（CHANGELOG_204 未结）

现有 `ratesSince(now-60000)` 查已落库 output。但生成中 assistant 帧 output_tokens≈0（spike case-b 实测仅 1），真实值只在 result 帧末尾写库一次 → 整个生成窗口无 output 数据 → rate 恒 0，只 turn 末写入后 60s 内非零，turn 间隔 >60s 连「跳一下」都看不到。新实时估算链路从根上解决（生成中持续推估算值）。

### D5. codex 无此能力（claude-only）

codex 无 stream_event → 永不进 liveBySession → header 对 codex bucket 恒走 poll 的 60s 窗口值。零代码，天然退化。

### D6. GC retention = 365 天默认，0=关闭（与 message 30d 刻意不同）

`v028_token_usage.sql:14` 注释明示「session 删除后 token_usage 保留，统计不应塌缩」——token_usage 是 daily dashboard 唯一历史源，retention 必须宽松。每行 ~10 ints + 2 短串，1 年重度使用（千 turn/天）≈ 数十 MB 可接受。

### D7. 实施顺序 = 先实现后 review（用户拍板 Q1）

先完整实现（MiniMax cleanup + tok/s streaming + GC + 文案），再把新代码与 token-usage 重灾区一起 deep-review。

### D8. 渲染集 = poll buckets ∪ fresh-live buckets（**Round 1 双方 HIGH 共识修订**）

**缺陷**（reviewer-claude + reviewer-codex 独立同时提出）：header 渲染行集来自 `top = topToday.slice()`（HeaderTokenRates.tsx:52），DataPanel 实时区来自 `rates.map()`（DataPanel.tsx:54），二者都是 **poll 数据**（DB 已落库 bucket）。仅把 L59 改成 `liveByBucket.get(bucketKey) ?? ...` 只改了**值查找**没改**迭代集** → 一个 bucket 若还没进 topToday/rates（DB 无今日 output 行），live tick 即便已 fire 也**无 row 可挂 → 不渲染**。

**触发场景正是 D4 承诺根治的最显眼时刻**：开 app 问第一句（pure-text turn）→ 流式期间只有 stream_event，assistant 帧（带 usage）+ result 帧都在 turn 末才到 → 整个生成窗口 DB 无 output → `today()` 返回空 → topToday 空 → header 迭代空集 → **生成全程空白**。HIGH-1 不修则 plan 核心目标在第一个问题上直接失效。

**修法**：渲染行集取 **fresh-live bucketKeys ∪ poll bucketKeys** 并集（用 liveBySession 里 fresh 项的 bucketKey 补进迭代集），再按 `live ?? poll ?? 0` 取值。Header（Phase 5.3）+ DataPanel（Phase 7.2）同款修。

**排名 comparator 钉死（R2 双方 MED-1）**：D8 初版写「live tps + topToday output 降序」是**未良定义 comparator**（tps[token/秒] 与 output[累计 token] 量纲不可加和）；maxItems 窄头分三档（HeaderTokenRates.tsx:47-48：`width≥620?3:≥470?1:0`），导致非空 topToday + 新 live bucket 场景下正在流式的 live-only bucket 被 idle 高累计 bucket 挤出 Top-N（开 app 问第二句起触发，HIGH-1 意图在窄头回退）。**正确 comparator = tuple 比较，fresh-live 优先不做量纲相加**：
```
排序 key = (hasFreshLive desc, liveTps desc, pollOutput desc)
// 1. fresh-live bucket 永远排在无 live 的 poll bucket 前
// 2. 都有 live：按 live tps 降序
// 3. 都无 live：按 poll output(今日累计) 降序
再 slice maxItems
```
保证正在流式的 bucket 永不被 idle 挤掉，直配 D4「生成中实时跳动」意图。Header（topToday 作 poll 源）+ DataPanel（rates 作 poll 源）共用同一 comparator（二者 poll 行都是 TokenRateRow{bucketKey,outputTokens}，可共用 helper，见不变量 11）。

### D9. turn 末即时校准（**Round 1 codex MED-1 修订**）

**缺陷**：done tick 删 live 后，精确 result 值只靠 `useTokenRatesPoll` 2500ms poll 拉，`token-usage-changed` 现仅被 DataPanel 用来 refetch daily（DataPanel.tsx:42）不刷 rates/topToday → turn 末「校准」变成「先归零 → 等一个 poll 周期（最多 2.5s）才显真值」，header 闪一下 0/旧值。违背「末尾校准」即时性承诺。

**修法**：让 `onTokenUsageChanged` 也立即触发 rates/topToday refresh（复用 useTokenRatesPoll 的 pull 逻辑，保留 interval 做时间衰减）。这样 result 落库 → emit token-usage-changed → renderer refetch rates/topToday → 精确值即时接管 live 归零的位置。

**debounce + latest-guard 钉死（R2 双方 MED-2）**：`token-usage-changed` 在 manager.ts:372 **每条 token-usage ingest 都 emit**（已验：turn 末 assistant 帧采集 sdk-message-translate.ts:271 按 distinct message-id + result correction L115/L140 多 bucket 成簇 emit 数条/turn/session）。D9 若每条都 refetch → 2 IPC + 2 GROUP BY 无节流，多 session（deep-review 10+ reviewer turn 末同时落库）簇发 ~60 IPC。**同文件已有相反先例铁证**：DataPanel 对同一 event 做 daily refetch 显式 debounce 500ms（DataPanel.tsx:19 `DAILY_REFETCH_DEBOUNCE_MS=500` + :44 setTimeout）。故：
- onTokenUsageChanged 触发的 rates/topToday refetch **走 debounce**（复用/共享 500ms 常量，与 daily 同源）。500ms 仍比被取代的 2500ms poll 快 5×，「末尾即时校准」承诺照样成立
- **latest-guard**：现有 use-token-rates-poll 仅 unmount `cancelled`（hook L24-38）无 request-seq，连续两次 event 旧响应可能迟到覆盖新结果 → 加 `requestSeqRef` 最新响应 wins（或 in-flight coalescing），防异步 UI 旧覆新

## 不变量

1. **估算值绝不落库**：'token-rate-tick' 走 eventBus → safeSend 直达 renderer，不碰 tokenUsageRepo.insert / ingest / token_usage 表。
2. **estimateTokensFromText 是纯函数**：无 I/O 无 side effect，单测可完全覆盖。
3. **stream_event 分支异常隔离**：handleStreamEventForLiveRate 整体 try/catch，估算失败绝不打断主翻译流（与 token-usage 采集 §不变量同款，L281-283 先例）。
4. **现有 token-usage 精确链路行为字节级不变**：抽取 helper 后 assistant/result 分支调用的函数仅 import 源变更，断言不变。
5. **facade import 不变**：被抽走的 helper 本就非 export（仅 translateSdkMessage/pushFileChangeIntent/consumePendingFileChangeIntent/maybeEmitImageFileChanged 是导出符号），移走零外部影响；translateSdkMessage 仍从 sdk-message-translate.ts 导出，importer（stream-processor.ts:25 等）零改动。
6. **单文件 ≤500 LOC**：sdk-message-translate.ts 当前 529（已超线），抽取后 ≈413。
7. **WINDOW_MS SSOT 不变**：60s 窗口 fallback 仍用 `@shared/model-normalize` WINDOW_MS=60000。
8. **normalizeModel bucketKey SSOT**：fixture 换名后 expected bucketKey/messageId 必须与 `normalizeModel(新model)` 实际输出一致（lowercase fallback）。
9. **渲染集是 fresh-live ∪ poll 的并集**（D8）：header/DataPanel 迭代行集必须包含 fresh liveBySession bucketKey，不止 topToday/rates；否则 live-only bucket 不渲染。fix 后必须有 test：`topToday=[] / rates=[] + live tick`（纯空）**且** `topToday=[A:5000] + live={B:80} + maxItems=1`（mixed，验证 live-first 排名）时 header/DataPanel 仍显示正在流式的 bucket。
10. **turn 末即时校准无 poll 延迟**（D9）：result 落库后 onTokenUsageChanged 触发的 refresh 必须刷 rates/topToday（不止 daily），让精确值即时接管 live 归零位置。必须有 Phase 8 test enforce（emit onTokenUsageChanged → 断言 tokenUsageRates/TopToday 各被调，与 daily refetch 独立）。
11. **LIVE_STALE_MS + 排名 comparator + fresh-live 聚合是 SSOT**（R2 双方 LOW）：仿 WINDOW_MS（model-normalize.ts:21 SSOT 先例）把 `LIVE_STALE_MS=1500` + `buildFreshLiveByBucket(liveBySession, now)` + 排名 comparator 抽到 shared 模块（或 store），Header（Phase 5.3）与 DataPanel（Phase 7.2）**import 同一份**，不各自定义常量/逻辑（否则 fresh 判定 / 排名漂移 → 两处对同 bucket 显示不同 tps）。
12. **liveBySession 无孤儿增长**（R2 claude MED）：session 中途被 kill/crash（无 result → 无 done tick）时 liveBySession[sessionId] 不能永久滞留。applyLiveTick 写时机会式 prune `now-updatedAt > LIVE_STALE_MS` 的所有 entry（或订阅 onSessionRemoved → delete）。fix 后必须有 test：set 两 session → 一个不发 done 直接「removed/stale」→ 断言 entry 被清（防 CHANGELOG_47 同类 Map leak）。

## 关键 ground truth（已 cat 核对，行号准确，交叉验证 Plan agent 引用 100% 命中）

### 数据源头：consume loop（唯一 translate 入口）
`src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:386`：
```
const sid = internal.applicationSid;
translateSdkMessage(this.ctx.emit, sid, m, internal);
```
所有 SDKMessage 都过这里。`m` = `{ type, session_id?, [k]:unknown }`。

### translate 函数（529 行，要加 stream_event 分支 + 抽取降 LOC）
`src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts`：
- L30 `type EmitFn`（保留，主函数签名用）
- L31-155：私有 helper（**均无 export**）—— UsageCounts/ZERO_USAGE/hasUsage/maxUsage/positiveDelta/addTurnUsage/sumTurnUsage/emitResultUsageCorrection
- L163-410：`translateSdkMessage(emit, sessionId, msg, internal)` 主函数，分支 assistant|user|result|system，**无 stream_event 分支**，L409 注释「其他 system subtype 与未知 type 忽略」无害 fallthrough
- L169：`const ts = Date.now()`（stream_event 分支复用此 ts）
- assistant token-usage 采集 L250-283（读 m.usage，去重 internal.seenUsageMessageIds，emit 'token-usage'）
- result 分支 L321-367：L361 `if (internal.expectedClose) return;`，L362 `emitResultUsageCorrection(e, internal, r)`
- L368-408：system init/status permissionMode 反向同步分支
- L412-528：pushFileChangeIntent / consumePendingFileChangeIntent / maybeEmitImageFileChanged（导出，不动）

### InternalSession 状态容器
`src/main/adapters/claude-code/sdk-bridge/types.ts`：interface InternalSession（L64起），turnUsageByBucket（L180-183）。makeInternalSession factory（L248起，L253-269 字段初始化，L268 注释确立「optional 字段默认 undefined 不显式初始化」约定，permissionModeChain/expectedClose/interruptFired 同款）。

### SDK partial message 类型（已核对 node_modules）
`@anthropic-ai/claude-agent-sdk/sdk.d.ts:3352` SDKPartialAssistantMessage：`{ type:'stream_event'; event: BetaRawMessageStreamEvent; parent_tool_use_id; uuid; session_id; ttft_ms? }`。
- `event.type==='content_block_delta'` → `event.delta` = BetaRawContentBlockDelta
- BetaTextDelta `{text:string, type:'text_delta'}`（messages.d.ts:1656）
- BetaThinkingDelta `{thinking:string, type:'thinking_delta'}`（messages.d.ts:1781）
- `event.type==='message_start'` → `event.message.model` + `event.message.usage`（spike runner-long.mjs:52-54 实证带 model）

### query options builder
`src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts:54` buildClaudeQueryOptions return（L69起）**无 includePartialMessages**。summarizer 走独立 settingSources:[] 路径不经此 builder（不污染）。

### event-bus
`src/main/event-bus.ts`：EventMap interface L25-115，已有 'token-usage-changed':[TokenUsageChangedEvent]（L114）。import 段 L13-23。

### IPC / preload / ipc-channels
- `src/shared/ipc-channels.ts`：IpcInvoke TokenUsageRates/TopToday/Daily（L101-105）；IpcEvent TokenUsageChanged（L215）
- `src/preload/api/misc.ts`：tokenUsageRates/TopToday/Daily（L212-219）
- `src/preload/api/events.ts`：onTokenUsageChanged subscribe（L56-57），import 段 L15-22
- `src/main/ipc/token-usage.ts`：3 handler + registerTokenUsageIpc

### renderer
- `src/renderer/stores/token-usage-store.ts`：zustand rates/topToday/daily + 3 setter
- `src/renderer/hooks/use-token-rates-poll.ts`：2500ms poll rates+topToday
- `src/renderer/components/HeaderTokenRates.tsx`：Top3，toRate(row)=outputTokens/(WINDOW_MS/1000)（L26-28），L59 `const tps = rateByBucket.get(row.bucketKey) ?? 0`
- `src/renderer/components/DataPanel.tsx`：实时区 liveRates useMemo（L54起）+ daily 表格，section header L81-83
- `src/shared/model-normalize.ts`：WINDOW_MS=60000（L21），normalizeModel(raw)→{bucketKey,displayName}（L108）

### GC（完全没接，要 wire — 锚点已核对真实）
- `src/main/store/token-usage-repo.ts:138` deleteOlderThan(thresholdMs) 已实现返回 changes
- `src/main/store/message-lifecycle-scheduler.ts`（6889 bytes，GC 镜像模板）
- bootstrap-wiring.ts 全文无任何 deleteOlderThan/setInterval/scheduler 引用它
- 设置项现状：`defaults.ts:50 messageRetentionDays:30`；`app-settings.ts:212 messageRetentionDays:number`
- scheduler wiring 锚点（核对真实）：`_deps.ts:17,38,49`（import/BootstrapState/factory）；`lifecycle-hooks.ts:23,100,101`（import/stop/setNull）；`bootstrap-infra.ts:49-51,287-291`（import/new/start/setX）；`settings.ts:87 applyMessageGcThreshold + :278/281 APPLY_FNS`

### MiniMax fixture（6 处，全仓只此一文件 — rg 核实）
`src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts`：
- L256 标题串 `（MiniMax-M3 tok/s=0 回归）`
- L263 `model: 'MiniMax-M3'`（assistant fixture）
- L279 `'MiniMax-M3': {...}`（modelUsage key）
- L294 `model: 'MiniMax-M3'`（expect tu[0]）
- **L300 `messageId: 'result:result-1:minimax-m3'`**（lowercase 形态 — load-bearing：= `result:${uuid}:${bucketKey}`，bucketKey=lowercase(model)）
- L301 `model: 'MiniMax-M3'`（expect tu[1]）

独立 `M3`（Agent Teams Milestone / REVIEW_7 M3 review label）≈27 处不在本文件，不动。

## 步骤 checklist（先实现后 review）

### Phase 0：进 worktree（user confirm 后）
- [x] Step 0.1 — `git -C <main-repo> worktree add -b worktree-tok-rate-realtime-streaming-20260603 <main-repo>/.claude/worktrees/tok-rate-realtime-streaming-20260603`（避开 EnterWorktree CLI stale base bug，走 Bash 两步形式）
- [x] Step 0.2 — `EnterWorktree(path: <worktree-abs-path>)` 进入；`pwd` 自检 + `git -C <worktree> rev-parse HEAD` == 34ab566

### Phase 1：MiniMax fixture 清理（最小、独立、先做立 baseline）
- [x] Step 1.1 — 改 `sdk-message-translate-token-usage.test.ts` 6 处：5 处 `MiniMax-M3` → `test-model-x`（L256 标题/L263/L279/L294/L301），L300 `minimax-m3` → `test-model-x`。验证 `normalizeModel('test-model-x').bucketKey === 'test-model-x'`（fallback lowercase，无变体后缀，`-x` 不匹配 `/-(x?high|low|medium|minimal)\b/`）
- [x] Step 1.2 — 跑该测试文件确认绿（`pnpm exec vitest run <file>`，注意 better-sqlite3 ABI：本文件 mock event-bus/session-repo 不碰真 SQLite，安全）

### Phase 2：LOC 抽取（为 stream_event 分支腾空间，行为字节级不变）
- [x] Step 2.1 — 新建 `src/main/adapters/claude-code/sdk-bridge/token-usage-accounting.ts`：移走 sdk-message-translate.ts L31-155 全部私有 helper（UsageCounts 类型/ZERO_USAGE/hasUsage/maxUsage/positiveDelta/addTurnUsage/sumTurnUsage/emitResultUsageCorrection，~123 行），改为 **export**（供 translate import）。新文件需 `import { normalizeModel } from '@shared/model-normalize'`（addTurnUsage:59 + emitResultUsageCorrection:112 用）+ InternalSession/AgentEvent 类型 import
- [x] Step 2.2 — sdk-message-translate.ts 删 L31-155，顶部加 `import { maxUsage, positiveDelta, addTurnUsage, emitResultUsageCorrection } from './token-usage-accounting';`（保留 L30 EmitFn）。**同时删 L26 `import { normalizeModel }`**（R1 reviewer-claude LOW-1：主函数体 163-410 零处直接调 normalizeModel，已 grep 确认仅 L26/59/112/129，后三者全在抽走块内 → 不删则 noUnusedLocals typecheck 挂）。eventBus(L20)/sessionRepo(L19)/AGENT_ID(L27) 留主文件（system 分支 L401-405 + L171 用）不动。主函数体不动
- [x] Step 2.3 — `pnpm typecheck` + 跑 token-usage test 确认抽取后行为不变（不变量 4/5）

### Phase 3：流式估算核心（live-token-rate.ts）
- [x] Step 3.1 — 新建 `src/main/adapters/claude-code/sdk-bridge/live-token-rate.ts`：
  - `estimateTokensFromText(text)`：CJK_RE 正则 + CJK_DIVISOR=1.7 / ASCII_DIVISOR=4，for-of 按 code point 数 CJK。**纯函数仅吃单帧增量文本**
  - `handleStreamEventForLiveRate(internal, sessionId, msg, now)`：message_start arm（**完整重置 R2 claude LOW：`estTokensSinceFlush=0; lastFlushTs=now; emaTps=undefined`** — 不止清 estTokens，否则新 turn 第一 tick 与上 turn 残留 EMA 混算）/ content_block_delta 累计估算 + THROTTLE_MS=250 节流 + EMA 平滑 + eventBus.emit('token-rate-tick')。**R1 reviewer-claude LOW：每帧对 delta.text/delta.thinking 的增量文本调 estimateTokensFromText，结果累加进 estTokensSinceFlush 这个 running count，绝不保留增长 text buffer 重扫（避免 O(n²) × 高帧率 37帧/s CPU 烧）**
  - **EMA 首帧不 blend（R2 claude LOW）**：`emaTps = emaTps === undefined ? tps : EMA_ALPHA*tps + (1-EMA_ALPHA)*emaTps`（EMA_ALPHA=0.4）。初值 undefined（非 0），首 flush 直接取真值（否则首帧只报 `0.4*tps` 冷启动欠报 60%）
  - **delta-before-arm 边界（R2 claude LOW）**：content_block_delta 先于 message_start 到时，显式 lazy-arm fallback bucket（'unknown'）或 skip，**不靠读 undefined.bucketKey throw 被 try/catch 静默吞**（否则整 turn 无 live 且隐蔽）
  - **tps 公式钉死（R1 reviewer-claude INFO）**：`tps = estTokensSinceFlush / ((now - lastFlushTs) / 1000)`（真实流逝，不硬除 0.25 — THROTTLE_MS 是最小间隔非实际帧距，thinking gap ~942ms 时实际间隔远大于 250ms）
  - `clearLiveTokenEstimate(internal, sessionId, now)`：置 undefined + emit done tick tps:0。**整体 try/catch（不变量 3）— clearLiveTokenEstimate 自身也包 try/catch（R1 codex MED-1：不能让 live listener throw 阻断 result 主链路）**
- [x] Step 3.2 — types.ts 加 `export interface LiveTokenEstimateState { bucketKey: string; estTokensSinceFlush: number; lastFlushTs: number; emaTps: number; }` + InternalSession（L183 后）加 `liveTokenEstimate?: LiveTokenEstimateState;`（可选，factory 不改 — 与 expectedClose 同款 lazy 约定）
- [x] Step 3.3 — sdk-message-translate.ts：result 分支 L361 `if (internal.expectedClose) return;` **之前**插 `clearLiveTokenEstimate(internal, sessionId, ts);`（两条路径都归零：normal completion 走到 clear；expectedClose 也先 clear 再 return）；system 分支后（L408 后、L409 注释前）加 `} else if (msg.type === 'stream_event') { handleStreamEventForLiveRate(internal, sessionId, msg, ts); }`。顶部 import live-token-rate。**plan 显式记（R1 reviewer-claude LOW）：expectedClose 路径加 done tick 是有意为之（display-only 归零，session abort 时确实该停 header 残留速率），不属 REVIEW_13 Bug 6 的告警通道（红字/finished/系统通知），不违反「整体静默」精神**
- [x] Step 3.4 — query-options-builder.ts return（L69起）加 `includePartialMessages: true,` + jsdoc（说明流式 tok/s 估算依赖，summarizer 不经此 builder 不受影响）

### Phase 4：IPC push channel
- [x] Step 4.1 — `src/shared/types/token-usage.ts` 加 `export interface TokenRateTickEvent { sessionId: string; bucketKey: string; tps: number; ts: number; done?: boolean; }`
- [x] Step 4.2 — event-bus.ts：import 加 TokenRateTickEvent；EventMap（L114 后）加 `'token-rate-tick': [TokenRateTickEvent];`
- [x] Step 4.3 — ipc-channels.ts IpcEvent（L215 后）加 `TokenRateTick: 'event:token-rate-tick',`
- [x] Step 4.4 — preload/api/events.ts：import 加类型；L57 后加 `onTokenRateTick: (cb) => subscribe<TokenRateTickEvent>(IpcEvent.TokenRateTick, cb),`
- [x] Step 4.5 — bootstrap-wiring.ts（L95 token-usage-changed 桥后）加 `eventBus.on('token-rate-tick', (p) => safeSend(IpcEvent.TokenRateTick, p));`

### Phase 5：renderer 消费
- [x] Step 5.0 — **新建 shared live-rate helper（SSOT，不变量 11）**：抽 `LIVE_STALE_MS=1500` + `buildFreshLiveByBucket(liveBySession, now)`（fresh 过滤 now-updatedAt≤STALE + 按 bucket 求和）+ `rankLiveAwareBuckets(freshLiveByBucket, pollRows)`（tuple comparator：`(hasFreshLive desc, liveTps desc, pollOutput desc)`）到 shared 模块（如 `src/shared/live-rate.ts` 或 renderer util）。Header + DataPanel import 同一份，杜绝漂移
- [x] Step 5.1 — token-usage-store.ts 加 `liveBySession: Record<string,{bucketKey:string;tps:number;updatedAt:number}>` + `applyLiveTick(t)` reducer（done 删项 / 否则 set，用接收时间 Date.now() 做 staleness）。init liveBySession:{}。**机会式 prune（不变量 12 / R2 claude MED）：applyLiveTick 写时顺手 delete 所有 `now-updatedAt > LIVE_STALE_MS` 的 entry（防 session 被 kill 无 done tick → 孤儿永留，CHANGELOG_47 同类 Map leak）**
- [x] Step 5.2 — 订阅接线 + **即时校准（D9 / 不变量 10）**：token tick 订阅挂 **use-token-rates-poll.ts**（R1 reviewer-claude 已确认 use-event-bridge.ts 是 5-session 全局 hub 无 token，token tick 应与 poll 同生命周期不进全局 hub）useEffect 加 `window.api.onTokenRateTick(applyLiveTick)`。**同时订阅 onTokenUsageChanged 触发 rates/topToday refetch**（result 落库 → 立即刷，不等 2500ms interval）。**debounce + latest-guard（R2 双方 MED-2 / 不变量 10）**：refetch 走 debounce（复用 daily 同源 500ms 常量 — manager.ts:372 每条 token-usage ingest 都 emit，turn 末成簇）；加 `requestSeqRef` 最新响应 wins（现有 hook 仅 unmount cancelled 无 seq-guard，连续 event 旧响应会迟到覆盖新结果）
- [x] Step 5.3 — HeaderTokenRates.tsx（**HIGH-1 并集 + comparator，D8 / 不变量 9/11**）：import Step 5.0 helper。**渲染行集 = `rankLiveAwareBuckets(buildFreshLiveByBucket(liveBySession, now), topToday)` 取前 maxItems**（不再仅 `top = topToday.slice()`）；每项 `tps = freshLiveByBucket.get(bucketKey) ?? rateByBucket.get(bucketKey) ?? 0`。**L56 `top.length > 0` 门控改为基于并集结果**（否则 topToday 空 + 有 live 时整区隐藏）。title 的「今日输出」对 live-only bucket（topToday 无该行）用 `?? 0` 兜底

### Phase 6：GC wiring
- [ ] Step 6.1 — app-settings.ts（L212 后）加 `tokenUsageRetentionDays: number;` + jsdoc（强调统计源、默认长保留 365、0=永久）；defaults.ts（L50 后）加 `tokenUsageRetentionDays: 365,`
- [ ] Step 6.2 — 新建 `src/main/store/token-usage-lifecycle-scheduler.ts`：镜像 message-lifecycle-scheduler.ts，DEFAULT_TICK_INTERVAL_MS=6h，scan() retentionDays≤0 跳过 / >0 调 deleteOlderThan(now-Nd) + removed>0 emit token-usage-changed{sessionId:'gc'}，try/catch。单例 set/getTokenUsageLifecycleScheduler
- [ ] Step 6.3 — wiring：_deps.ts（import+BootstrapState+factory）；bootstrap-infra.ts（L287-291 messageScheduler 后 new+start+setX）；lifecycle-hooks.ts（L100-101 后 stop+setNull）；settings.ts（仿 applyMessageGcThreshold 加 applyTokenUsageGcThreshold 注册进 APPLY_FNS）
- [ ] Step 6.4 — **Settings UI（MED-3 / R1 codex）**：`src/renderer/components/settings/sections/LifecycleSection.tsx` 加一个 NumberInput（紧邻现有 messageRetentionDays，L64 后），`label="Token 统计保留（天，0 = 关闭 GC）"` + `value={settings.tokenUsageRetentionDays}` + `onChange={(v) => void update({ tokenUsageRetentionDays: v })}`。否则 D6「0=关闭/365 默认」对用户不可达（现有 history/issue×2/message 共 4 个 retention 都在此 section 暴露）。若有 settings UI 快照测试同步补

### Phase 7：DataPanel 文案 + 实时区 live override
- [ ] Step 7.1 — DataPanel.tsx section header（L81-83）加小字说明「顶栏与本区为流式估算（按字符近似，生成中实时跳动）；下方表格为 turn 末精确值」
- [ ] Step 7.2 — DataPanel liveRates useMemo（L54起，**HIGH-1 并集 + comparator，D8 / 不变量 9/11**）：import Step 5.0 同一 helper。渲染集 = `rankLiveAwareBuckets(buildFreshLiveByBucket(liveBySession, now), rates)`（与 header 共用 comparator + fresh 判定，杜绝口径漂移）；每 bucket `tps = freshLiveByBucket.get(bucket) ?? r.outputTokens/(WINDOW_MS/1000)`。现有 `.filter(r=>r.tps>0)`（DataPanel.tsx:63）改为基于合并后 tps（保留 live-only bucket：poll tps=0 但 live>0）。表格区（daily）不动

### Phase 8：测试
- [ ] Step 8.1 — 新建 `live-token-rate.test.ts`：estimateTokensFromText 纯中文/纯英文/混合量级；mock eventBus 喂 message_start+N text_delta 验仅 ≥THROTTLE_MS 边界 emit + EMA + thinking_delta 计入 + done tick。**加异常隔离用例（R1 reviewer-claude MED / 不变量 3）：喂畸形 stream_event 让 handleStreamEventForLiveRate 内部 throw → 断言不抛出（被 try/catch 吞）+ 无 tick emit，套用 sdk-message-translate-token-usage.test.ts:240-254 既有 isolation test 模板**
- [ ] Step 8.2 — translate 集成测试（扩展现有或新 ...-stream-event.test.ts）：喂 stream_event 不产生 AgentEvent（无 DB 污染）+ eventBus.emit('token-rate-tick') 被调；result 帧仍 emit token-usage+finished 且清 live。**加断言（R1 reviewer-claude LOW）：expectedClose=true 时 result 帧 fire done tick（tps:0）但无 finished/message emit（验证 done tick 不属 Bug 6 告警通道）**；**加廉价保险断言（R1 双方 INFO）：stream_event 不干扰 consume first-id 解析**
- [ ] Step 8.3 — 新建 `token-usage-lifecycle-scheduler.test.ts`：镜像 message scheduler test，retentionDays=0 跳过 / >0 调 deleteOlderThan / removed>0 emit / stop 清 timer / scan throw 不崩（mock tokenUsageRepo+eventBus 避 ABI 陷阱）
- [ ] Step 8.4 — token-usage-store + 渲染集测试：
  - applyLiveTick：done 删项 / set fresh / 多 session 共存 / **机会式 prune（不变量 12）：set 两 session → 一个不发 done 直接 stale（updatedAt 调老）+ 再来一个 tick 触发 prune → 断言 stale entry 被清**
  - **HIGH-1 渲染集回归（不变量 9）**：① 纯空 `topToday=[]/rates=[] + live tick` → header/DataPanel 显示 live-only bucket；② **mixed 排名（R2 双方 MED-1）：`topToday=[A:5000] + live={B:80} + maxItems=1` → 断言显示正在流式的 B（验证 live-first comparator，不被 idle 高累计 A 挤出）**
  - **Step 5.0 helper 单测**：buildFreshLiveByBucket（stale 边界过滤）+ rankLiveAwareBuckets（tuple comparator：fresh-live 优先 → liveTps → pollOutput）
- [ ] Step 8.5 — **query-options-builder 单测（R1 codex LOW）**：断言 `buildClaudeQueryOptions(...).includePartialMessages === true`（流式唯一生产入口，漏实现时 helper/translate 单测仍全绿但 SDK 永不发 partial）。注释说明 summarizer 不经此 builder 不受污染
- [ ] Step 8.6 — **不变量 10 即时校准测试（R2 双方 MED-2）**：mock window.api.tokenUsageRates/TopToday → emit onTokenUsageChanged → 断言两者各被调（与 daily refetch 独立）；**连续两次 event 验 latest-guard：旧响应迟到不覆盖新响应**（requestSeq wins）；验 debounce 500ms 簇发合并

### Phase 9：验证 + Deep-Review
- [ ] Step 9.1 — `pnpm typecheck` 必过 + `pnpm build` 大改动跑
- [ ] Step 9.2 — 重启 dev（改 main/preload 必须）实测：跑一个有产出 session，观察 header tok/s 生成中实时跳动 + turn 末回落 + codex session 退化正常
- [ ] Step 9.3 — invoke `agent-deck:deep-review`（kind='mixed'，scope=本次新增/改动文件 + token-usage 重灾区），多轮异构对抗 + 反驳轮 + 三态裁决；HIGH 必修 MED 现场验证
- [ ] Step 9.4 — review 通过 → README/changelog/conventions 检查 → archive_plan 收口

## 当前进度

- ✅ spike 复核 + 补测（spike3 长输出实证 message_delta 仍单发，堵上 spike1「只测短输出」盲区）
- ✅ ground truth 全链路重建 + 交叉验证 Plan agent 引用 100% 命中
- ✅ plan 文件写完
- ✅ **Deep-Review Round 1 完成**（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，异构对抗）：
  - **HIGH-1 双方独立提出 = ✅ 必修**：渲染集只覆盖值不扩集，live-only bucket（开 app 第一句）不渲染 → 已修进 D8 + 不变量 9 + Phase 5.3/7.2
  - **codex MED-1（即时校准）= ✅**：done tick 后精确值靠 2.5s poll 闪烁 → 已修进 D9 + 不变量 10 + Phase 5.2
  - **codex MED-3（Settings UI）= ✅**：tokenUsageRetentionDays 没接 LifecycleSection → 已加 Phase 6.4
  - **claude MED（不变量3缺测）= ✅** → Phase 8.1 加异常隔离用例
  - **claude LOW-1（import 孤儿）= ✅ 硬伤**：抽走 helper 后 L26 normalizeModel 成孤儿 typecheck 挂 → 已修进 Phase 2.2
  - **codex LOW（includePartialMessages 缺测）= ✅** → Phase 8.5
  - **claude LOW（done tick 注释）/ 2 INFO（tps 公式 / staleness 闪烁）= ✅ 钉死** → Phase 3.1/3.3 + 已知踩坑
  - 双方独立确认：test-model-x bucketKey 断言正确 / spike inline 准确 / 行级 reference 全准 / GC wiring 锚点真实
  - 0 条被反驳 finding，无需反驳轮
- ✅ **Deep-Review Round 2 完成**（同对 reviewer 复用，验证 R1 fix + 挖第二层）：R1 七条 fix 双方复核全部正确落位；第二层 4 MED / 3 LOW（全「plan 层钉死规格」级，0 HIGH 0 推翻设计）：
  - **R2 排名 comparator 未定义 双方独立 = ✅ 必修**：`live tps + topToday output` 量纲相加，maxItems=1/3 窄头时 live-only bucket 被 idle 高累计挤出（HIGH-1 意图窄头回退）→ 修进 D8 tuple comparator `(hasFreshLive desc, liveTps desc, pollOutput desc)` + 不变量 11 + Phase 5.0/5.3/7.2
  - **R2 D9 无 debounce 双方独立 = ✅ 必修**：token-usage-changed 每条 ingest 都 emit（manager.ts:372），turn 末成簇 → 修进 D9 debounce 500ms（复用 daily 同源常量）+ latest-guard（requestSeq）+ Phase 5.2
  - **R2 不变量10 无测 双方 = ✅** → Phase 8.6
  - **R2 liveBySession 孤儿 leak（claude 单方，plan 规格可见 + 现场验证）= ✅ 必修**：session 被 kill 无 done tick → entry 永留（CHANGELOG_47 同类）→ 修进不变量 12 + Phase 5.1 机会式 prune + Phase 8.4
  - **R2 LIVE_STALE_MS/comparator 非 SSOT 双方 = ✅** → 不变量 11 + Phase 5.0 抽 shared helper
  - **R2 message_start 重置不完整 + EMA 首帧欠报 + delta-before-arm（claude LOW）= ✅** → Phase 3.1 钉死
  - **R2 不变量9 漏 mixed（claude LOW）= ✅** → Phase 8.4 mixed 用例
  - codex 主动排除：GC {sessionId:'gc'} payload 合法 + 6h 一次不成风暴；claude 确认多 session 同 bucket tps 求和语义正确（与 poll 同口径）
  - reviewer-claude 明示「Round 3 不必再起，4 MED 纳入即同意 conclude」；0 条被反驳，无需反驳轮
- ✅ **Deep-Review 收口（Round 3 双方明示 conclude 共识）**：
  - reviewer-claude：逐条复读改动节（非凭摘要），0 HIGH/0 open MED/0 LOW 残留，确认 R2/R3 改动无引入新问题，额外认可 latest-guard 补充。「同意 conclude」
  - reviewer-codex：nl/rg 重读 plan 对应节 + 抽查 HeaderTokenRates/DataPanel/use-token-rates-poll/token-usage-store 现状确认覆盖，0 HIGH/0 MED 新增。「同意 conclude」
  - 两轮 review 共拦 1 HIGH + 6 MED（全在写代码前修进 plan），其中 HIGH-1（live-only bucket 不渲染）+ 排名 comparator（窄头挤掉 live bucket）若漏到实施会让核心目标在最显眼场景静默失效
  - 两 reviewer 已 shutdown（events/messages 保留可引用）
- ✅ **进 worktree 实施 Phase 1-5 完成**（WIP commit `3228372`，base `9afbf68`，branch worktree-tok-rate-realtime-streaming-20260603）：
  - ✅ Phase 1 fixture 清理（6 处 codename → test-model-x，11 tests 绿）
  - ✅ Phase 2 LOC 抽取（token-usage-accounting.ts，sdk-message-translate 529→408 行，typecheck + 测试绿）
  - ✅ Phase 3 流式核心（live-token-rate.ts + types LiveTokenEstimateState + translate stream_event 分支 + result clearLiveTokenEstimate + query-options includePartialMessages，typecheck 绿）
  - ✅ Phase 4 IPC channel（TokenRateTickEvent + event-bus 'token-rate-tick' + ipc-channels TokenRateTick + preload onTokenRateTick + bootstrap-wiring 桥，typecheck 绿）
  - ✅ Phase 5 renderer（lib/live-rate.ts SSOT helper + store liveBySession+applyLiveTick+prune + hook tick 订阅+onTokenUsageChanged 即时校准 debounce500+latest-guard + Header 并集+comparator，typecheck 绿）
  - 每 Phase 过 typecheck（worktree 内用主仓库 binary：`/Users/apple/Repository/personal/agent-deck/node_modules/.bin/tsc --noEmit -p tsconfig.json`）；测试同理用主仓库 vitest binary + worktree cwd
- ⏳ 下一步：Phase 6（GC wiring）/ 7（DataPanel）/ 8（测试）/ 9（验证 + 实施期 mixed deep-review）

## 下一会话第一步（更新 — Phase 1-5 已实施完，从 Phase 6 续）

**plan design 已双对抗 review 收口；Phase 1-5 已实施 + WIP commit。新会话从 Phase 6 续。**

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/tok-rate-realtime-streaming-20260603.md` 全文
2. `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/tok-rate-realtime-streaming-20260603)` 进 worktree（已存在，commit `3228372`）
3. 自检：`git -C <worktree> log --oneline -1` 应见 `3228372 wip(tok-rate): Phase 1-5`；`pwd` 确认在 worktree
4. **按 Phase 6 → 7 → 8 → 9 行级 checklist 续做**（先实现后 review）：
   - Phase 6 GC wiring：app-settings/defaults 加 tokenUsageRetentionDays:365 → 新建 token-usage-lifecycle-scheduler.ts（镜像 message-lifecycle-scheduler.ts）→ wiring（_deps/bootstrap-infra/lifecycle-hooks/settings APPLY_FNS/LifecycleSection UI NumberInput）
   - Phase 7 DataPanel：section header 加实时估算说明文案 + liveRates useMemo 用 lib/live-rate 同一 buildFreshLiveByBucket+rankLiveAwareBuckets（与 Header 共用，传 rates 作 poll 源）
   - Phase 8 测试：6 文件（live-token-rate.test 含异常隔离 + translate stream_event 集成 + scheduler test + store applyLiveTick/prune + 渲染集纯空&mixed + query-options includePartialMessages + 不变量10 即时校准）
   - Phase 9 验证：typecheck + build + 重启 dev 实测 + invoke agent-deck:deep-review kind='mixed' 对真实代码再评一轮 + archive_plan 收口
5. **关键执行约定**：
   - typecheck/测试用主仓库 binary + worktree cwd：`zsh -i -l -c "/Users/apple/Repository/personal/agent-deck/node_modules/.bin/tsc --noEmit -p tsconfig.json"` / 同款 vitest（worktree 无独立 node_modules）
   - 所有代码路径用 worktree 前缀 `.claude/worktrees/tok-rate-realtime-streaming-20260603/`
   - better-sqlite3 ABI 陷阱：测试全 mock repo/eventBus 不碰真 SQLite（详 §Phase 8）
   - 改 main/preload 需重启 dev 才生效（Phase 9.2 实测前）
6. Phase 全部过后 archive_plan 收口（base_branch=main，写 CHANGELOG）

## 已知踩坑（spike 残留风险）

- **估算误差**：CJK /1.7 ASCII /4 是粗近似，代码/JSON/emoji 密度偏离大（display-only，result.modelUsage 末尾校准兜底，divisor 抽常量便于调）
- **throttle 丢精度**：250ms 内多帧合并瞬时尖峰被平滑（EMA α=0.4 折中），极短 turn <250ms 可能一次 tick 都不发就 done（UI 一闪而过，可接受）
- **decay 时机**：崩溃/abort 无 result done tick 时靠 LIVE_STALE_MS(1.5s)+poll(2.5s) 回落，最坏滞留 ~2.5s
- **多 session 并发 IPC 量**：N session × 4 tick/s，典型 1-3 session 无压力；deep-review 起 10+ reviewer 并发流式时 40+ tick/s safeSend，后备方案给 bridge 加 16ms debounce（按 sessionId 合并）
- **thinking 模型稀疏**：opus thinking-max delta avg ~942ms → tick 稀疏速率跳动（thinking_delta 已计入 + EMA 平滑，残留仍偏跳）
- **首帧延迟（冷启动）**：spike case A 首跑 50s/0 delta，生成开始数秒无 tick → header 显示 poll 旧值或 0（未引入 loading 态，回落 poll 值已够）
- **message_stop 未显式清**：多 message turn 工具执行间隙靠 staleness 衰减非即时归零，工具执行 <1.5s 时 header 短暂显示上一 message 残留速率（可选细化：message_stop emit done）
- **staleness 闪烁（R1 reviewer-claude INFO）**：tool 执行 gap >1.5s 时 live entry 转 stale → 回落 poll 值（生成中≈0）→ header 掉 0 → 下条 message 又跳回，轻微闪烁。staleness 在 render 时求值无自带 timer，靠 poll(2.5s) setRates 驱动 re-render 重算（故「最坏滞留 ~2.5s」成立但机制隐式）。display-only 可接受
- **stream_event 带 session_id**：consume L286 first-id 逻辑类型无关（仅读 m.session_id 不看 m.type），且 system:init 仍是 query 首个 id-bearer（realId set 后 L286 `!realId` 短路，后续 stream_event 不入 first-id 块）→ message_start 实际不会成首帧，低风险（Phase 8.2 加廉价保险断言）
- **GC 删统计源**：tokenUsageRetentionDays 设太短吞 daily dashboard 历史（default 365 + jsdoc 警示 + 0=永久 + Phase 6.4 Settings UI 可调）

---

## 附录：归档的 spike 实测产物（spike-reports/）

详见 `spike-reports/` 同名子目录（plan frontmatter `spike_reports_path` 记录绝对路径）：

- **spike1-partial-messages.md** —— Claude Agent SDK `includePartialMessages` 实测，确认 `content_block_delta` 高频但只带文本、`message_delta` 被 CLI 压成 turn 末单发 → 锁定「文本估算」路径。配套 `runner.mjs` + `case-a-default-model.log` / `case-a2-opus-rerun.log` / `case-b-haiku.log` / `case-c-sonnet.log`。
- **spike2-codex-realtime.md** —— codex SDK 端实测，确认 codex 无 `stream_event` 推流路径 → D5 codex 天然退化走 60s 窗口的论据。配套 `codex-runner.mjs` + `codex-case-a.log` / `codex-case-b-long.log` / `codex-case-c-cmd.log` / `codex-runner-cmd.mjs` / `codex-runner-long.mjs`。
- **spike3-long-haiku.log** —— 长输出（haiku 4704tok/41.8s）实测 message_delta 仍单发，堵上 spike1「只测短输出」盲区，让 D1「message_delta 单发」从短输出偶然上升为 CLI 通道硬限制结论。配套 `runner-long.mjs`。

所有 .log / .mjs / .md 永久入 git（`spike-reports/` 例外条目已写进 `.gitignore` 跳过全局 `*.log` 过滤），作为 D1 决策（精确 token delta 不可行，必须文本估算）的不可变 evidence。
