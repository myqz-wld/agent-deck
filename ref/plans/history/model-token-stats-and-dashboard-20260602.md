---
plan_id: "model-token-stats-and-dashboard-20260602"
created_at: "2026-06-02"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/model-token-stats-and-dashboard-20260602"
status: "completed"
base_commit: "ad0fd5e510673c11992df9d961065ae57b9f173f"
base_branch: "main"
final_commit: "7a230f1aaf74f4712fd1dcd68f9288018482fedf"
completed_at: "2026-06-02"
---
# Plan: 模型 Token 统计 + Header Top3 token/s + 数据 Tab

## 总目标

在**不触碰现有事件语义**的前提下，新增一条「token 使用」采集→持久化→查询→展示的垂直切片，支撑三个用户需求：
1. **Header 中部 Top3 模型实时 token/s**（今日输出 token 排名前 3 的模型 + 各自 60s 窗口 token/s）
2. **顶部 tab 级数据模块**（模型×日期表 + 顶部汇总 + 顶部全模型实时 token/s 区），进入按钮与 实时/待处理/历史/团队/问题 同级
3. **窄宽度下需求1 退化隐藏**，适配不同窗口宽度
4. （追加）数据页面也有较实时 token/s

## 设计决策（不再争论）

### RFC 决策（用户确认 / 推荐采纳）
- **token/s 口径**：滑动 60s 窗口内各模型已完成 turn 的 **output tokens** 总和 ÷ 窗口秒数。turn 完成即刷新（非秒级流式）。(RFC 第1轮 Q1 = 一定时间窗口内速率)
- **Top3 排名**：**今日(本地日期) · 输出 token 总量**降序取前 3。(RFC 第2轮，用户委托推荐)
- **需求2 指标**：input / output / cacheRead / cacheCreation tokens。**不要费用**（costUSD 不采集不展示）。(RFC 第1轮 Q3 + 追加「暂不需要估算费用」)
- **需求2 展示**：表格(模型×日期) + 顶部汇总行 + 顶部一行「各模型实时 token/s」(全部模型不只 Top3)。(RFC 第1轮 Q4 + 追加)
- **模型归一**：同基础模型不同变体(thinking/1m/非thinking)合并为一个 bucket + 显示友好名(如 "Opus 4.8")；DB 同时存原始 model id 保粒度。(RFC 第2轮推荐)
- **窗口时长**：60s 硬编码常量(不做设置项)。(RFC 第2轮推荐)

### Spike 决策（spike1 铁证，见 spike-reports/spike1-token-usage-source.md）
- **采集点放 assistant message，不放 result message**：`SDKAssistantMessage.message: BetaMessage` 自带 `id`(去重锚点) + `model`(模型名) + `usage{input/output/cache}`。官方文档证实 assistant usage 是 per-step 增量(非累计) → 直接累加入库，**绕开 result.modelUsage 累计/增量谜题**。(spike1 假设 A/B/C)
- **必须按 message.id 去重，但用 max-merge 而非 first-seen**(deep-review R1 F1 codex-HIGH 修订)：同 turn 多 tool_use 共享同一 id。官方 cost-tracking 文档双层语义：① 正常情况同 id message 携带 **identical** usage（first-seen 即足够，官方主推荐 seenIds.has skip）② **rare case** 同 id 不同 output_tokens → "Use the highest value: the final message in a group typically contains the accurate total"。故去重策略不能 first-seen skip（rare case 会取到偏小值低估 output），改 **max-merge**：
  - DB 层：`INSERT ... ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO UPDATE SET output_tokens=max(output_tokens,excluded.output_tokens), input_tokens=max(...), cache_read_tokens=max(...), cache_creation_tokens=max(...)`（同 id 任一指标更大值覆盖）。**conflict target 必带 `WHERE message_id IS NOT NULL` 谓词**（partial index 要求，R2 H1 实测；抄 event-repo.ts:78-84 范式）。**不用 INSERT OR IGNORE**（那会丢 rare case 的更大值）。
  - internal `seenUsageMessageIds` **Map** 保留**作快路径剪枝**（绝大多数同 id 帧 identical，命中且 4 指标都不更大时直接 skip emit 省 IPC/DB 往返）——但 Map 必须存**完整 4 指标 tuple**（非仅 output），**任一指标 > 已见值即放行** emit 让 DB max-merge 收口（deep-review R2 G2 codex-LOW-1：只比 output 会让"同 id 但 input/cache 更大"的帧被快路径错误拦下，DB 永远看不到可 merge 的行）。即 `Map<id, {input,output,cacheRead,cacheCreation}>`，新帧任一指标 > 对应已见才重新 emit + 更新 Map（per 指标取 max 存回）。
  - 回归 test：同 id 第二条 output 更大 → daily/top/rates 用更大值（测试矩阵已加）。
- **Codex 采集点 = turn.completed**：usage per-turn，model 从 sessions.model 取（codex event 不带 model），无 cache_creation(填0)、cacheRead=cached_input_tokens、reasoning_output 归入 output。(spike1 假设 E)
  - **codex effective model 解析**(deep-review R1 F2 双方独立 codex-MED + claude-MED-3 修订)：现状 `session-finalize.ts:85` 仅 `if(model)` 才 setModel，交互式 codex 不显式传 model 时走 `~/.codex/config.toml` 默认 → DB null → **所有不同 model 的交互式 codex 会话全折进同一 unknown bucket**（非 edge，是交互式 codex 常态），丧失「每模型」统计意义。修法：codex createSession 持久化 **effective model** = `opts.model ?? readTopLevelModelFromCodexConfig() ?? 'codex-default'`。
    - **新增** `readTopLevelModelFromCodexConfig()` 到 `src/main/codex-config/toml-writer.ts`（deep-review R2 G1 双方独立 claude-MED-1 + codex-LOW-2：是**新代码**非"复用整段"——toml-writer 无顶层裸 key reader，可复用的仅 `parseTomlString` 值解析 helper；**不引 TOML parser** 依赖，行级扫描，REVIEW_2 半截 config 解析失败教训）。**算法钉死**(防误匹配，R3 LOW-1 加 inline comment + literal 单引号覆盖，reviewer-claude 已 13-case 实测通过)：逐行 trim → 忽略空行/`#`注释 → **遇 `/^\s*\[/`(section header) 立即停止**(顶层 key 必在任何 table header 之前) → 用正则**直接捕获首个引号 token**(basic `"..."` 或 literal `'...'`)，尾部 inline comment 自然忽略：
      ```ts
      const m = /^model[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(line);
      if (m) { const tok = m[1]; return tok[0] === '"' ? parseTomlString(tok) : tok.slice(1, -1); }
      if (/^model[ \t]*=/.test(line)) return null; // model= 在但值非引号形态 → 顶层 model 行但无法解析,停
      ```
      精确锚 `model` 后紧跟 `=`/空格**排除 `model_provider`/`model_providers`** 误命中；basic string 走 `parseTomlString`(含转义)，literal `'...'` 无转义直接剥引号。读不到 → 返 null。
    - 持久化点：codex `session-finalize.ts` 把 `if(model)` 改为先 resolve effective model 再 setModel（effective model 至少是 'codex-default' 非 null）。这样 turn.completed 取 sessions.model 永非 null。
    - UI 兜底：'codex-default' / 'unknown' bucket 显示「Codex (默认模型)」/「未知模型」，让用户理解 codex 未显式指定 model 时统计合并的局限。
- **不采集 costUSD**：assistant message 无 costUSD（仅 result.modelUsage 有），且用户不展示费用 → 采集层不引费用。(spike1 假设 D)
- **不开 includePartialMessages**：避免冲击现有事件链 + codex 不对称。「较实时」= 60s 窗口聚合，turn 完成刷新，非秒级流式。(spike1 假设 F)
- **存明细不预聚合**：60s 窗口需行级 ts；每天聚合用 `GROUP BY date(ts/1000,'unixepoch','localtime')` 同表算。SQLite 量级预聚合收益可忽略。

## 不变量（实施必须守）

1. **dedupOrClaim 必须最前**：token-usage 早返分支只能放在 `dedupOrClaim(...).skip` 之后、`ensureRecord` 之前。
2. **token-usage 不污染主事件流**：**不写 events 表**、**不进 activity 状态机**、**不 emit `agent-event`**。做法是 ingest 早返分支（不 fall-through 到后 4 段），现有 5 段一行不改。
3. **采集失败不阻塞主事件流**：`persistTokenUsage` 整体 try/catch（DB 异常只 warn）；翻译层抽 usage 也 try/catch，绝不让采集 throw 打断 message/finished emit。
4. **模型归一 SSOT 单处**：归一算法只在 `src/shared/model-normalize.ts` 一处，main(写 bucket) 与 renderer(显示友好名) 都 import，禁止各处写 regex。
5. **去重双层 = Map 快路径 + DB max-merge**(deep-review R2 G2 codex-LOW-1 措辞修订)：claude 走 `internal.seenUsageMessageIds` **Map<id, 4指标tuple>** 快路径（任一指标更大才放行 emit，非 first-seen Set）+ DB `ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO UPDATE SET <4指标>=max(...)` max-merge 兜底；codex turn.completed 每 turn 一次(message_id 存 NULL 不参与 partial UNIQUE)。
6. **窗口常量单处**：`WINDOW_MS = 60_000` 单一 export，main 查询与 renderer 文案共用。
7. **token-usage 与 finished 解耦**：codex `turn.completed` 现有 `emit('finished', {usage})` **不动**；新增独立 `emit('token-usage')`。claude 在 assistant 分支新增独立 emit，不改任何现有分支。
8. **AgentEventKind 仅追加**：`agent.ts` union 末尾追加 `'token-usage'`，不改顺序。
9. **测试最小改动**(deep-review R1 F4 claude-MED-2 修订)：现有 events / activity / finished **行为**不变(不变量 2/7 保证)。**例外**：translate **层**既有 emit count 断言因新增 token-usage emit 需同步更新（translate 层本就在改，属预期变更，非破坏现有行为）——已知必改：`src/main/adapters/codex-cli/__tests__/translate.test.ts:54`（`turn.completed → finished` 用例 `toHaveLength(1)` → `toHaveLength(2)` + 断言第2条是 token-usage）。实施 A2/A4 后**必跑全 vitest 套件**确认无其他 count 断言连带破（claude 侧已查 file-change-intent-delay.test.ts 等都 `filter(e=>e.kind===...)` 不受影响，但实施者须全套件验证兜底）。
10. **token-usage 早返在 isRecentlyDeleted 之后是预期行为**(deep-review R1 F6 claude-INFO-2)：早返放 `manager.ts:354 dedupOrClaim 后`，即也在 `isRecentlyDeleted(manager.ts:350)` 之后 → 60s 黑名单内已删 session 的迟到 token-usage 会被 drop。**这是预期**（被删/shutdown session 的尾包 usage 不应计入统计），非遗漏。

## 数据模型

新建 `src/main/store/migrations/v028_token_usage.sql`（范式 v026_issues.sql）：

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT,              -- 纯 TEXT 列(无硬 FK，deep-review R1 F3)：仅供可选 drill-down，日聚合 by model_bucket 不依赖它
  agent_id               TEXT NOT NULL,     -- 'claude-code' | 'codex-cli'，按 adapter 过滤
  message_id             TEXT,              -- claude BetaMessage.id（去重锚点）；codex NULL
  model_raw              TEXT NOT NULL,     -- 原始 model id 保粒度
  model_bucket           TEXT NOT NULL,     -- 归一 bucket key（写时算，GROUP BY 用）
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,  -- codex 无 → 0
  ts                     INTEGER NOT NULL   -- epoch ms
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_message_id ON token_usage(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(ts);
CREATE INDEX IF NOT EXISTS idx_token_usage_bucket_ts ON token_usage(model_bucket, ts);
```

**session_id 去硬 FK**(deep-review R1 F3 claude-MED-1)：原设计 `FOREIGN KEY(session_id) REFERENCES sessions(id)` + `db.ts:21 foreign_keys=ON` 与 §不变量2「token-usage 早返不建 session row」张力 —— claude 新 spawn 时 session row 由 finalizeSessionStart(create-session-impl.ts:191) emit session-start 创建，而首条 assistant frame(带 usage)由后台 consume loop(stream-processor.ts:235)处理，两者经 microtask 竞争。实践 finalize 几乎总先赢(system-init→first-assistant 有 LLM 网络间隔)，但代码结构不保证；竞态输→FK INSERT 撞父行不存在→被不变量3 try/catch 吞→**首条 usage 静默丢失**。**修法**：session_id 改纯 TEXT 列去硬 FK（日聚合 by model_bucket 不需 FK，session_id 仅可选 drill-down）—— 同时消除竞态 + 兑现不变量2 解耦意图。session 删除后 token_usage row 保留（统计不应因 session GC 塌缩，符合需求2「历史每天」语义）。

**去重 = max-merge 非 first-seen**(deep-review R1 F1)：`INSERT INTO token_usage(...) VALUES(...) ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO UPDATE SET output_tokens=max(output_tokens,excluded.output_tokens), input_tokens=max(input_tokens,excluded.input_tokens), cache_read_tokens=max(...), cache_creation_tokens=max(...)`（rare discrepancy 取最大值，见 §设计决策 spike 决策第2条）。

⚠️ **partial index conflict 必带 WHERE 谓词**(deep-review R2 H1 claude-HIGH，sqlite3 3.43.2 实测复现 + 违反 REVIEW_52 已立约定)：`uq_token_usage_message_id` 是 **partial** unique index(`WHERE message_id IS NOT NULL`)，SQLite 要求 partial-index 作 conflict target 时**必须在 ON CONFLICT 子句重复该 WHERE 谓词**(字节级一致)，否则 `Error: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint` parse error。实施直接抄 `event-repo.ts:78-84` 现成正确范式(连 RETURNING id：DO UPDATE 命中 conflict 时 lastInsertRowid 是 attempt rowid 非 victim，取 victim 必须 RETURNING)。codex message_id=NULL 不触发 partial UNIQUE，每 turn 独立 INSERT 新行(codex 无同 id 重复)。

注册：`migrations/index.ts` 加 `import v028` + `MIGRATIONS.push({version:28,name:'token_usage',sql:v028})`（当前最后 v027）。

**display 名不入库**：renderer 从 bucket 经 SSOT 派生（改文案无需迁移）。

## 步骤 checklist

### Phase 0：归一 SSOT（独立，最先做）
- [ ] **M** — 新建 `src/shared/model-normalize.ts`（policy 标注），export `normalizeModel(raw): {bucketKey, displayName}` + `WINDOW_MS=60_000`。算法：lowercase → 去 `[1m]`/`-thinking`/`-max` 等后缀 → claude/gpt 表驱动映射 → fallback 原样 / null→`unknown`+「未知模型」。+ 单测覆盖测试矩阵「模型归一」行。
- [ ] 在 `src/shared/types.ts` barrel + 必要 export 接线（若 normalizeModel 放 shared 根则无需）。

### Phase 1：采集层
- [ ] **A1** — `src/shared/types/agent.ts:6` AgentEventKind union 末尾加 `| 'token-usage'`。
- [ ] **A3** — `src/main/adapters/claude-code/sdk-bridge/types.ts` InternalSession 加 `seenUsageMessageIds: Map<string, {input:number;output:number;cacheRead:number;cacheCreation:number}>`（id→4指标 tuple，max-merge 快路径剪枝用，G2）；factory 初始化 `new Map()`。
- [ ] **A2** — `sdk-message-translate.ts` assistant 分支(line 48-108)：扩 cast 含 `id/model/usage`（id/model/usage 读自 `m`=msg.message=BetaMessage，**非 msg**，F7 claude-INFO-3）。blocks 循环后 try/catch 内：算 4 指标(cache_* `?? 0`) → 查 `prev=seen.get(id)`，`!prev || input>prev.input || output>prev.output || cacheRead>prev.cacheRead || cacheCreation>prev.cacheCreation`(任一更大) → `seen.set(id, {各指标取 max(prev,新)})` + `e('token-usage', {messageId:id, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens})`（G2：4 指标任一更大才放行，非仅比 output；DB 端 ON CONFLICT max 收口）。
- [ ] **A4** — `codex-cli/translate.ts` turn.completed(line 197)：保留 finished 不动，新增 `emit('token-usage', {messageId:null, model:opts?.model??null, inputTokens, outputTokens:output+reasoning, cacheReadTokens:cached_input, cacheCreationTokens:0})`。扩 `translateCodexEvent` 签名加 `opts?:{model?:string|null}`。**同步改 `translate.test.ts:54`**（`toHaveLength(1)`→`(2)` + 断言第2条 token-usage，F4）。
- [ ] **A4b** — `codex-cli/sdk-bridge/thread-loop.ts:339` 调用点传 `{model: sessionRepo.get(internal.applicationSid)?.model ?? null}`（确认/加 sessionRepo import）。
- [ ] **A4c**(F2 codex effective model) — `codex-cli/sdk-bridge/session-finalize.ts:85`：`if(model)` 改为先 resolve effective model = `model ?? readTopLevelModelFromCodexConfig() ?? 'codex-default'` 再 setModel。**新增**(非复用) `readTopLevelModelFromCodexConfig()` 到 `src/main/codex-config/toml-writer.ts`：行级扫描遇 `[` 停 + 精确锚 `/^model[ \t]*=/`(排除 `model_provider`) + `parseTomlString` 解析值(G1)。让 sessions.model 永非 null。时序已验证安全(R2 INFO-2：persistSessionFields 在 thread.started 后、首轮 turn.completed 前)。
- [ ] **A5** — `manager.ts` ingest()(line 354 dedupOrClaim 后)加早返：`if (event.kind==='token-usage'){ persistTokenUsage(event); eventBus.emit('token-usage-changed',{sessionId,ts}); return; }`。`manager-ingest-pipeline.ts` 加 export `persistTokenUsage(event)`（范式 persistFileChange，整体 try/catch，调 tokenUsageRepo.insert + normalizeModel 算 bucket）。

### Phase 2：查询层
- [ ] **DB** — 新建 v028 migration + index.ts 注册（见数据模型节，session_id 纯 TEXT 无 FK / max-merge ON CONFLICT）。
- [ ] **Q1** — 新建 `src/main/store/token-usage-repo.ts`（facade 范式 issue-repo）：`insert`(**ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO UPDATE SET output_tokens=max(...) 等 4 指标 max-merge**，R2 H1 必带 WHERE 谓词，抄 event-repo.ts:78-84 范式，非 INSERT OR IGNORE) / `today(startMs)`(GROUP BY bucket SUM output DESC) / `ratesSince(sinceMs)`(同) / `dailyByModel(from?,to?)`(GROUP BY bucket,day 4指标) / 可选 `deleteOlderThan`。**边界参数计算点钉死**(F6)：startMs(本地午夜)/sinceMs(now-WINDOW_MS) 由 **IPC handler 层用本地 tz 算**(main 与 renderer 同机同 tz)，与 SQL `date(...,'localtime')` 对齐；repo 只收 ms 参数。
- [ ] **Q2** — `src/shared/ipc-channels.ts`：IpcInvoke 加 `TokenUsageRates`/`TokenUsageDaily`/`TokenUsageTopToday`；IpcEvent 加 `TokenUsageChanged`。
- [ ] **Q4** — `src/main/event-bus.ts` EventMap 加 `'token-usage-changed':[{sessionId,ts}]`；`src/main/index/bootstrap-wiring.ts` 加 `eventBus.on('token-usage-changed', p=>safeSend(IpcEvent.TokenUsageChanged,p))`。
- [ ] **Q3** — 新建 `src/main/ipc/token-usage.ts`（named export + registerTokenUsageIpc + zod 校验）；`ipc/index.ts` import + bootstrapIpc() 加注册。
- [ ] **Q5** — `src/shared/types/token-usage.ts`(TokenRateRow/TokenDailyRow/TokenUsageChangedEvent) + barrel export；`src/preload/api/misc.ts` 加 invoke + `src/preload/api/events.ts` 加 `onTokenUsageChanged`。

### Phase 3：Renderer
- [ ] **R0** — 新建 `src/renderer/hooks/use-container-width.ts`（ResizeObserver 测宽度，卸载 disconnect）。独立可先做。
- [ ] **R1** — 新建 `src/renderer/stores/token-usage-store.ts`（rates/topToday/daily + setter，范式 issues-store）。
- [ ] **R2** — 新建 `src/renderer/hooks/use-token-rates-poll.ts`（setInterval 2.5s 拉 rates+topToday，仅 header/数据页挂载时跑，卸载清 interval）。daily 走 push（DataPanel 内订阅 onTokenUsageChanged debounce 500ms refetch）。
- [ ] **R3** — `App.tsx`：View type(line 20) 加 `'data'`；header 左信息区与右控制区之间插 `<HeaderTokenRates/>`（topToday 前3 + token/s，用 use-container-width 阈值 `HEADER_TOPRATES_MIN_PX≈560` 以下 return null；可选两级退化）。新组件 `src/renderer/components/HeaderTokenRates.tsx`。
- [ ] **R4** — `App.tsx`：右控制区「问题」TabButton 后加「数据」TabButton(同 teams/issues 模式)；main view 分支加 `view==='data' ? <DataPanel/>`。
- [ ] **R5** — 新建 `src/renderer/components/DataPanel.tsx`：顶部全模型实时 token/s 行 + 顶部汇总行 + 主体表格(行=bucket displayName，列=日期，cell=4指标，无费用)。

### Phase 4：收尾（可选 / 低优先）
- [ ] **GC**（可选）— `defaults.ts`+`app-settings.ts` 加 `tokenUsageRetentionDays`(默认建议 90)，复用 scheduler tick 调 deleteOlderThan + `ipc/settings.ts` 热更新。**本期可暂缓**，先让明细无界增长（量级可控），GC 作为 follow-up。
- [ ] **验证** — `pnpm typecheck` + 改 main 重启 dev 实测 + 打包验证（README 三问 + changelog）。
- [ ] **README + changelog** — 改 README「主要能力」+ 新建 CHANGELOG_X（功能变更）。

## 测试矩阵

| 层 | 关键 test |
|---|---|
| claude 翻译 | 同 id 4 指标全相同多帧只 emit 一次(Map 快路径剪枝)；**同 id output 更大 → 重新 emit(F1)**；**同 id output 相同但 cacheRead/input 更大 → 也重新 emit(G2，4 指标任一更大放行)**；不同 id 各计一次；cache_* null→0；assistant 无 usage 不 emit；采集 throw 不打断 message emit |
| codex 翻译 | turn.completed emit finished + token-usage 两条(`translate.test.ts:54` 同步改 toHaveLength 2)；cacheCreation=0/cacheRead=cached_input；output=output+reasoning；model 透传 opts.model；model null→unknown |
| codex effective model(F2/G1) | session-finalize resolve effective model：opts.model 优先 / config.toml 顶层 model 次之 / 'codex-default' 兜底；**readTopLevelModelFromCodexConfig section-aware**：顶层 model 在第一个 `[section]` 前→取值；**无顶层 model 但 `[profiles.foo]\nmodel="x"`→返 null(不误读 section 内)**；**`model_provider="y"` 不被误命中**；`# model=` 注释不命中；**inline comment `model="x" # primary`→取 x(R3 LOW-1)**；**literal 单引号 `model='x'`→取 x(R3 LOW-1)**；hash-in-value `model="g#5"`不误截；读不到返 null |
| ingest | token-usage 早返：不写 events / 不 emit agent-event / 不动 activity；dedupOrClaim 仍最前；persistTokenUsage 调一次；throw 被吞；**isRecentlyDeleted 内 token-usage 被 drop(F6 预期)** |
| repo | **max-merge：同 message_id 第二条 output 更大 → DB output 更新为更大值(F1)**；同 id 更小值不覆盖；codex NULL message_id 可插多行；3 查询 SQL 正确；**session 删后 token_usage row 仍在(去 FK，F3)** |
| 模型归一 | opus/sonnet/haiku alias、`claude-opus-4-8-thinking-max[1m]`→Opus 4.8、gpt-5.5、'codex-default'→「Codex(默认模型)」、未知 fallback、null/空 |
| 窗口边界 | ts=now-60s 的 `>=` 边界；多 bucket 求和；空窗口 0 |
| 午夜边界 | 跨本地午夜分到不同 day；今日用本地 startOfToday(IPC 层算，F6) |
| 宽度阈值 | width≥阈值显示 / <阈值 return null；hook mount/unmount 清理 |

## 已知踩坑

1. **codex 默认模型聚合局限(F2 升级)**：交互式 codex 不显式传 model 时走 config.toml 默认 → **A4c 已让 effective model 至少落 'codex-default'**(非 null)。但若用户多个不同 model 都用 config.toml 默认(未在 agent-deck 显式指定) → 仍会合并进同一 'codex-default' bucket(读 config.toml 顶层 model 只能拿到一个全局默认值)。**非 edge 是交互式 codex 常态**。UI 标注「Codex (默认模型)」让用户理解 codex 未显式指定 model 时统计合并的局限。彻底分模型需用户在 spawn 时显式指定 model。
2. **claude usage cache_* 可为 null**：类型 `number|null`，必须 `?? 0` 否则 NOT NULL 列崩。
3. **实时刷新性能**：rates poll 2.5s 走 `idx_token_usage_bucket_ts`；不放进全局 use-event-bridge；仅活跃视图跑；daily push+debounce。
4. **token-usage 误入 events/activity**：必须早返；误 fall-through 会让活动流出现 token-usage 行 + 卡片刷成 working。
5. **毛玻璃 CSS 陷阱**：header 中部区**不要**自带 backdrop-filter/不透明底（二次模糊）；复用 text-deck-muted / bg-white/x 等 token，与 TabButton 同款（CLAUDE.md 毛玻璃约定）。
6. **HMR**：改 main(translate/ingest/repo/migration/IPC) 必须重启 electron；renderer HMR 不覆盖 main；v028 首次运行建表。
7. **seenUsageMessageIds(Map) 增长**：长会话 Map 累积(id→output)，随 internal session GC 释放；DB UNIQUE + max-merge 才是真兜底。
8. **header 5→6 tab 变挤**：窄宽务必保证 6 tab 可点 → Top3 区最先退化。阈值需在真实布局目测校准。
9. **better-sqlite3 binding**：跑 SQLite 真测前后保护 binding（CLAUDE.md 打包节教训），默认走 test 顶部 skip 守门不主动跑。
10. **采集核心假设 *未验证*(F5 claude-INFO-1)**：per-step 增量 / 同 id 去重来自官方 docs，spike1 未真跑 SDK。docs 强暗示同 id message 携带 identical usage(故 dedup 不漏算)，但若 SDK 实际在同 id 多 message 塞不同增量则会 UNDER-count。F1 max-merge 已部分缓解(取最大值)。建议实施后用一个真 multi-tool turn 实测一次确认。
11. **codex-sdk lockfile drift(F7 INFO-4)**：package.json `^0.135.0` 但 node_modules 实际 0.131.0，引的字段在 0.131-0.135 稳定。实施前 `pnpm install` 对齐版本再写 A4/A4b。
12. **per-column max 的 frankenstein row 局限(R2 I1 claude-INFO-1)**：4 指标各自独立取 max，rare discrepancy 下可能产出从未作为单帧存在的合成行（如 output 取终帧 90 + cacheRead 取首帧 200，而官方语义是"终帧整行含 accurate total"）。**影响极小**：需求1 Top3/token/s 只用 output(恒取最大=正确)不受影响；仅数据 tab 的 cache 列在 rare discrepancy 下可能略高估几个 token。严格对齐"终帧整行"需 ts 排序判终帧，复杂度不值 → **维持 per-column max + 此处注明局限**（reviewer-claude 建议）。

## step 依赖顺序

```
M (归一 SSOT, 独立最先) ──────────────────┐
A1 (kind) ─> A2/A3(claude) ┐               │
           └> A4/A4b(codex) ├> A5(ingest) ─┤(依赖 Q1 repo)
v028 migration + index ─────┘              ▼
                          Q1(repo) ─> Q3(IPC handler)
                          Q2(channels) ─> Q3/Q5 ; Q4(eventBus+桥) 依赖 Q2
                                                    ▼
                          R1 store ─> R2 hooks ─> R3 header / R4 tab / R5 DataPanel
                          R0 use-container-width (独立, 可先做)
```

**可并行**：M 最先(A5/Q1 都要)；v028 与采集层(A1-A4)并行；R0 与全后端并行；claude(A2/A3) 与 codex(A4) 并行；Q2 定好后 Q3/Q5/R1 并行起草。

## 当前进度

- [x] 探索代码库（数据流 / 采集点 / 存储 / IPC / renderer / 响应式现状全摸清）
- [x] RFC 两轮（口径 / 排名 / 指标 / 展示 / 归一 / 窗口全部对齐）
- [x] spike1 静态验证（采集架构 + SDK 铁证，绕开真跑 SDK）
- [x] plan 文件写完
- [x] deep-review Round 1（reviewer-claude 0H/3M/4I + reviewer-codex 1H/1M）→ 4 条 MED fix 进 plan：F1 max-merge 去重 / F2 codex effective model / F3 去硬 FK / F4 测试措辞 + F6 边界计算点
- [x] deep-review Round 2（claude 1H/1M/2I + codex 0H/0M/2L）→ fix：H1 partial index conflict 补 WHERE 谓词(sqlite3 实测复现) / G1 readTopLevelModel section-aware(双方独立) / G2 Map 快路径存 4 指标 tuple / I1 frankenstein 局限注明。codex 已同意 conclude，claude 待 H1 确认
- [x] deep-review Round 3（claude 0H/0M/1L + codex 0 findings）→ **双方共识 conclude** ✅。fix R3 LOW-1（readTopLevelModel inline comment + literal 单引号，reviewer-claude 13-case 实测正则版采纳）。reviewer 已 shutdown
- [x] 用户 confirm 进 worktree（base ad0fd5e）
- [x] **Phase 0-4 全部实施完成**：Phase 0 归一 SSOT / Phase 1 采集层 / Phase 2 查询层 / Phase 3 renderer / Phase 4 验证
- [x] 验证全绿：typecheck node+web ✅ / 全量 1736 tests（Electron-as-node ABI 130，0 skip 0 regression）✅ / electron-vite build 三端 ✅ / dev 实测 migration v28 真执行 + 应用启动无崩溃 + 3 查询/max-merge/归一真 DB 验证 ✅
- [x] 文档：CHANGELOG_197 + INDEX + README 主要能力 ✅
- [x] 单文件护栏自检：最大新文件 DataPanel 177 行，全在 500 内 ✅
- [ ] **下一步：用户验收 → archive_plan 归档（ff-merge worktree → base_branch main）**

## 实施完成总结

**14 新增文件**：model-normalize.ts(+test) / types/token-usage.ts / token-usage-repo.ts(+test) / v028 migration / ipc/token-usage.ts / sdk-message-translate-token-usage.test.ts / use-container-width.ts / use-token-rates-poll.ts / token-usage-store.ts / HeaderTokenRates.tsx / DataPanel.tsx / CHANGELOG_197.md
**25 修改文件**：agent.ts kind / types barrel / InternalSession+factory / sdk-message-translate(A2) / codex translate(A4)+test / thread-loop(A4b) / create-session-new(A4c) / toml-writer(+test) / manager+ingest-pipeline(A5) / migrations index / event-bus / bootstrap-wiring / ipc-channels / ipc index / preload misc+events / App.tsx / 2 测试 fixture / _setup.ts

deep-review 3 轮收口的所有 finding 都在实施中落地（max-merge 带 WHERE 谓词 / codex effective model section-aware / 去硬 FK / 4 指标快路径 / 测试 carve-out）。

## 下一会话第一步

若本会话中断，新会话接力：
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/model-token-stats-and-dashboard-20260602.md`
2. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/model-token-stats-and-dashboard-20260602/spike-reports/spike1-token-usage-source.md`
3. deep-review 已 3 轮收口（双方 conclude，0 HIGH/0 MED）。**用户已 confirm** → 按 §Step 2 进 worktree 实施
4. 进 worktree 走主路径：`git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-model-token-stats-and-dashboard-20260602 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/model-token-stats-and-dashboard-20260602` + `EnterWorktree(path:"/Users/apple/Repository/personal/agent-deck/.claude/worktrees/model-token-stats-and-dashboard-20260602")`（避开 CLI stale base bug）
5. 实施顺序：Phase 0 (M 归一 SSOT) → Phase 1 (采集 A1-A5) → Phase 2 (查询 DB/Q1-Q5) → Phase 3 (renderer R0-R5) → Phase 4 (验证 + README + changelog)。每 phase 后 typecheck，改 main 重启 dev 实测
