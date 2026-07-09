# CHANGELOG_197 — 模型 Token 统计：Header Top3 token/s + 数据 Tab

## 概要

新增一条「token 使用」采集 → 持久化 → 查询 → 展示的完整垂直切片，落地用户两个需求 + 一个追加：
1. **顶栏中部显示使用最频 Top3 模型的「输出 token/s」**，窗口宽度不足时自动退化隐藏（响应式）。
2. **新增「数据」tab**（与 实时/待处理/历史/团队/问题 同级，第 6 个 tab）：每模型每天 token 使用表格（input/output/cacheRead/cacheCreation）+ 顶部今日汇总 + 顶部全模型实时 token/s 区。
3. （追加）数据页面也有较实时 token/s（与 header 同源）。

plan `model-token-stats-and-dashboard-20260602`（多会话 + worktree 隔离 + 两轮 RFC + spike + 3 轮 deep-review 全流程）。

## 设计要点

- **采集地基**（此前几乎为零）：token 用量此前完全没采集。采集点放 **assistant message**（claude，自带 `BetaMessage.id` 去重锚点 + `model` + `usage`）+ **turn.completed**（codex）。官方 cost-tracking 文档证实 assistant usage 是 per-step 增量（非会话累计），绕开 result.modelUsage 的累计/增量谜题。
- **token/s 口径**：滑动 60s 窗口内各模型已完成 turn 的 output tokens ÷ 窗口秒数（turn 完成即刷新，非秒级流式）。**不开 `includePartialMessages`**（避免冲击现有事件链 + codex 不对称）。
- **Top3 排名**：今日（本地日期）· 输出 token 总量降序。
- **模型归一**：同基础模型变体（`-thinking` / `-thinking-max` / `[1m]`）合并为一个 bucket + 友好显示名（如 `Opus 4.8`）；DB 同存 `model_raw` 保粒度。归一算法 SSOT 单处 `src/shared/model-normalize.ts`，main 写 bucket + renderer 显示名共用。
- **不采集费用**：assistant message 无 costUSD + 用户不展示费用 → 采集层不引费用维度。
- **去重 max-merge**（deep-review R1 F1）：同 message_id 正常携带 identical usage，rare discrepancy 取最高值（官方文档）。internal Map 4 指标快路径剪枝 + DB `ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO UPDATE SET <4指标>=max(...)` 兜底（partial index conflict target 必带 WHERE 谓词，REVIEW_52 约定）。
- **不污染主事件流**（不变量）：token-usage 走 ingest 早返旁路（dedupOrClaim 后、ensureRecord 前），不写 events 表 / 不进 activity 状态机 / 不 emit agent-event；采集失败 try/catch 吞不阻塞会话。
- **响应式从零引入**：renderer 此前无 ResizeObserver / matchMedia，新增 `use-container-width` hook 测 header 宽度，两级退化（≥620px 显示 Top3 / ≥470px 显示 Top1 / <470px 隐藏）。

## 变更内容

### Phase 0 — 模型归一 SSOT

- **新建 `src/shared/model-normalize.ts`**（policy）：`normalizeModel(raw) → {bucketKey, displayName}` + `WINDOW_MS=60_000`。section-aware 后缀剥离 + family/version 解析 + alias + codex-default/unknown 兜底。

### Phase 1 — 采集层

- `src/shared/types/agent.ts`：`AgentEventKind` union 加 `'token-usage'`。
- **新建 `src/shared/types/token-usage.ts`**：`TokenUsagePayload` / `TokenRateRow` / `TokenDailyRow` / `TokenUsageChangedEvent` + barrel export。
- `sdk-bridge/types.ts`：`InternalSession` 加 `seenUsageMessageIds: Map<id, 4指标tuple>` 快路径 + factory 初始化。
- `sdk-message-translate.ts`（A2）：assistant 分支扩 cast 含 `id/model/usage`（读自 `m`=msg.message=BetaMessage），blocks 循环后 try/catch 采集 token-usage（4 指标任一更大才放行 emit，cache_* `?? 0`）。
- `codex-cli/translate.ts`（A4）：`translateCodexEvent` 加 `opts?:{model?}` 形参；turn.completed 保留 finished + 新增独立 token-usage emit（reasoning 归入 output / cacheRead=cached_input / cacheCreation=0）。
- `codex-cli/sdk-bridge/thread-loop.ts`（A4b）：调用点传 `{model: sessionRepo.get(applicationSid)?.model}`。
- `codex-cli/sdk-bridge/create-session/create-session-new.ts`（A4c）：新建路径 resolve effective model = `opts.model ?? readTopLevelModelFromCodexConfig() ?? 'codex-default'`（仅新建路径，resume 保留原值），让 codex sessions.model 永非 null 不全折 unknown。
- `codex-config/toml-writer.ts`：新增 `readTopLevelModelFromCodexConfig()`——行级扫描读 `~/.codex/config.toml` 顶层 model（section-aware 遇 `[` 停 + 排除 `model_provider` 误命中 + inline comment / literal 单引号覆盖，不引 TOML parser，复用 parseTomlString）。
- `manager.ts` + `manager-ingest-pipeline.ts`（A5）：ingest 加 token-usage 早返分支 + `persistTokenUsage` free function（整体 try/catch，调 tokenUsageRepo.insert + normalizeModel 算 bucket）+ emit `token-usage-changed`。

### Phase 2 — 查询层

- **新建 `src/main/store/migrations/v028_token_usage.sql`** + 注册：`token_usage` 表（session_id 纯 TEXT 无硬 FK / message_id partial UNIQUE / model_raw+model_bucket 双存 / 3 索引）。
- **新建 `src/main/store/token-usage-repo.ts`**（facade）：`insert`（max-merge ON CONFLICT）/ `today` / `ratesSince` / `dailyByModel`（本地日期分组）/ `deleteOlderThan`。
- `ipc-channels.ts`：`TokenUsageRates` / `TokenUsageTopToday` / `TokenUsageDaily` invoke + `TokenUsageChanged` event。
- **新建 `src/main/ipc/token-usage.ts`** + 注册：3 handler（边界参数 startMs 本地午夜 / sinceMs now-WINDOW 在 handler 层用本地 tz 算）。
- `event-bus.ts` + `bootstrap-wiring.ts`：`token-usage-changed` EventMap + 桥接到 IPC。
- `preload/api/misc.ts` + `events.ts`：`tokenUsageRates/TopToday/Daily` invoke + `onTokenUsageChanged` 订阅。

### Phase 3 — Renderer

- **新建 `src/renderer/hooks/use-container-width.ts`**（ResizeObserver 测宽度）。
- **新建 `src/renderer/stores/token-usage-store.ts`**（zustand：rates/topToday/daily + setter）。
- **新建 `src/renderer/hooks/use-token-rates-poll.ts`**（2.5s poll rates+topToday，挂载即跑卸载清 interval）。
- **新建 `src/renderer/components/HeaderTokenRates.tsx`**：header 中部 Top3 模型 token/s + 响应式两级退化隐藏。
- **新建 `src/renderer/components/DataPanel.tsx`**：实时区（全模型 token/s）+ 今日汇总 + 模型×日期表格（daily 走 onTokenUsageChanged push debounce refetch）。
- `App.tsx`：View type 加 `'data'`；header 左信息区 `flex-1`→`shrink` + 插入 `<HeaderTokenRates/>`；右控制区加「数据」TabButton；main view 分支加 DataPanel。

## 测试

- 新增：model-normalize 17 + sdk-message-translate token-usage 9（max-merge 快路径 / 去重 / cache null / 不打断主流）+ codex translate token-usage 3 + toml section-aware 9（含 R3 inline comment / literal）+ token-usage-repo 11（max-merge / codex NULL 多行 / 3 查询 / 去 FK / GC，真 SQLite）。
- 改：codex `translate.test.ts:54` `toHaveLength(1)→(2)`（turn.completed 现 emit finished + token-usage）；`_setup.ts` makeMemoryDb 补 v027+v028；2 个 InternalSession fixture 补 `seenUsageMessageIds`。
- 全量 **1736 tests 全绿**（Electron-as-node ABI 130，0 skip 0 regression）；typecheck node+web 双绿；electron-vite build 三端绿；dev 实测 migration v28 真执行 + 应用正常启动 + 3 查询 SQL/max-merge/模型归一在真实 DB 验证正确。

## deep-review

3 轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5）：
- R1：0 HIGH/3 MED/4 INFO + 1 HIGH/1 MED → fix F1 max-merge / F2 codex effective model（双方独立）/ F3 去硬 FK / F4 测试措辞 + F6 边界计算点。
- R2：**1 HIGH**（我 R1 max-merge fix 新引入的 partial-index conflict 缺 WHERE 谓词 → SQLite parse error，lead sqlite3 真表复现 + 违反 REVIEW_52 约定）/ G1 section-aware（双方独立）/ G2 Map 4 指标快路径 → 全 fix。
- R3：0 HIGH/0 MED + 1 LOW（section-aware inline comment / literal，已采纳 reviewer-claude 13-case 验证正则）→ **双方共识 conclude**。

## 已知局限

- **codex 默认模型聚合**：交互式 codex 不显式指定 model（走 config.toml 默认）时，effective model 落 `codex-default` 占位，UI 显示「Codex (默认模型)」；多个用 config.toml 默认的不同 model 会合并进同一 bucket（读顶层 model 只能拿全局默认值）。彻底分模型需 spawn 时显式指定 model。
- **per-column max frankenstein row**：4 指标各自取 max，rare discrepancy 下 cache 列可能略高估几个 token（output 恒正确）；影响极小，维持现状。
- **采集核心假设**：per-step 增量 / 同 id 去重来自官方 docs（spike1 未烧钱真跑 SDK）；max-merge 已部分缓解。建议后续用真 multi-tool turn 实测确认一次。
