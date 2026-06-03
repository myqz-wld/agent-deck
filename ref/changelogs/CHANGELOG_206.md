# CHANGELOG_206

## header 实时 tok/s（流式估算·末尾校准）+ GC wiring + DataPanel 文案

> 关联 plan：`ref/plans/tok-rate-realtime-streaming-20260603.md`（归档后生效）
> 关联 review：plan design 已 plan-driven 双对抗收口（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，R1+R2 两轮）；本批为 plan-driven 实施无二次 deep-review（用户示意跳过对抗）

### 改动总览（2 commit · 12 文件改 + 2 新）

- **`3228372 wip(tok-rate): Phase 1-5 流式 tok/s 实时化（estimate·末尾校准）`**
  - `src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts` —— 6 处真实模型 codename `MiniMax-M3` / `minimax-m3` → `test-model-x`（测试 fixture 泄漏清理，Phase 1）。
  - `src/main/adapters/claude-code/sdk-bridge/token-usage-accounting.ts` —— **新增**：抽走 sdk-message-translate.ts L31-155 私有 helper（UsageCounts/ZERO_USAGE/hasUsage/maxUsage/positiveDelta/addTurnUsage/sumTurnUsage/emitResultUsageCorrection）改 export，腾 LOC + 复用（Phase 2）。
  - `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` —— 529→408 行（删 L26 normalizeModel import 避免孤儿，主函数体不动，行为字节级不变；Phase 2）。
  - `src/main/adapters/claude-code/sdk-bridge/live-token-rate.ts` —— **新增**：estimateTokensFromText 纯函数（CJK/ASCII 分系数）+ handleStreamEventForLiveRate（message_start 完整重置 + content_block_delta 节流 + EMA 首帧不 blend + delta-before-arm lazy fallback）+ clearLiveTokenEstimate（done tick 自身 try/catch）（Phase 3）。
  - `src/main/adapters/claude-code/sdk-bridge/types.ts` —— InternalSession 加 `liveTokenEstimate?: LiveTokenEstimateState`（lazy 约定，与 expectedClose 同模式）。
  - `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` —— result 分支插 `clearLiveTokenEstimate`（含 expectedClose 路径，display-only 归零），system 后加 stream_event 分支调 handleStreamEventForLiveRate（Phase 3）。
  - `src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts` —— `includePartialMessages: true`（summarizer 不经此 builder 不污染，Phase 3.4）。
  - `src/shared/types/token-usage.ts` —— 新增 `TokenRateTickEvent`（sessionId/bucketKey/tps/ts/done?，Phase 4.1）。
  - `src/main/event-bus.ts` —— EventMap 加 `'token-rate-tick'`（Phase 4.2）。
  - `src/shared/ipc-channels.ts` —— IpcEvent 加 `TokenRateTick: 'event:token-rate-tick'`（Phase 4.3）。
  - `src/preload/api/events.ts` —— `onTokenRateTick` subscribe（Phase 4.4）。
  - `src/main/index/bootstrap-wiring.ts` —— eventBus → safeSend 桥（Phase 4.5）。
  - `src/renderer/lib/live-rate.ts` —— **新增**：SSOT helper（§不变量 11）：`LIVE_STALE_MS=1500` + `buildFreshLiveByBucket`（fresh 过滤 + 按 bucket 求和）+ `rankLiveAwareBuckets`（tuple comparator `(hasFreshLive desc, liveTps desc, pollOutput desc)`，与 Header/DataPanel 共用，杜绝漂移）。
  - `src/renderer/stores/token-usage-store.ts` —— 加 `liveBySession` + `applyLiveTick`（done 删项 / 否则 set + 机会式 prune `now-updatedAt>LIVE_STALE_MS` 防 session 被 kill 无 done tick 孤儿永留，CHANGELOG_47 同类 Map leak 防线）。
  - `src/renderer/hooks/use-token-rates-poll.ts` —— 挂载 onTokenRateTick 订阅（不进 use-event-bridge 全局 hub，与 poll 同生命周期）+ onTokenUsageChanged 触发 rates/topToday refetch（debounce 500ms 复用 daily 同源常量 + requestSeq latest-guard 旧响应迟到不覆盖新结果）。
  - `src/renderer/components/HeaderTokenRates.tsx` —— 渲染行集 = `rankLiveAwareBuckets(buildFreshLiveByBucket, topToday)` 并集（§D8 修 HIGH-1，live-only bucket 不再空白），tps = fresh live ?? poll，title 区分「生成中实时估算」vs「最近 60s」。

- **`8961b77 feat(token-usage): Phase 6-7 GC wiring + DataPanel live override`**
  - `src/shared/types/settings/app-settings.ts` —— 加 `tokenUsageRetentionDays: number` 字段 + jsdoc（强调「统计源」「默认长保留 365」「0=关闭」）。
  - `src/shared/types/settings/defaults.ts` —— `tokenUsageRetentionDays: 365`。
  - `src/main/store/token-usage-lifecycle-scheduler.ts` —— **新增**：镜像 message-lifecycle-scheduler.ts pattern，6h tick `deleteOlderThan(now-Nd)` 单事务，**无 catch-up**（与 message 刻意不同，daily dashboard 重算代价低，理由详文件头注释），removed>0 才 emit `token-usage-changed{sessionId:'gc'}`，retentionDays≤0 早退，单例 set/get。
  - `src/main/index/_deps.ts` —— `BootstrapState` 加 `tokenUsageScheduler: TokenUsageLifecycleScheduler | null` + 初始 null。
  - `src/main/index/bootstrap-infra.ts` —— new + start + setX。
  - `src/main/index/lifecycle-hooks.ts` —— before-quit stop + setNull（防 6h tick 在 quit 期间继续碰 DB）。
  - `src/main/ipc/settings.ts` —— `applyTokenUsageGcThreshold` 进 APPLY_FNS（与 message GC 同款热更新语义）。
  - `src/renderer/components/settings/sections/LifecycleSection.tsx` —— 加 NumberInput `Token 统计保留（天，0 = 关闭 GC）`，让用户可调（与 history/message/issue GC 同 section 一站式暴露）。
  - `src/renderer/components/DataPanel.tsx` —— section header 文案改「流式估算（按字符近似，生成中实时跳动）；下方表格为 turn 末精确值」+ liveRates useMemo 改用 `lib/live-rate` 同一 `buildFreshLiveByBucket` + `rankLiveAwareBuckets`（与 Header 共用，filter 改基于合并后 tps 保留 live-only bucket）+ title 区分实时估算 vs 60s 窗口。

### 核心设计决策（不再争论，spike 实测锁）

- **D1 估算 vs 精确**：Anthropic SSE `content_block_delta` 只带文本不带 token；带 token 的 `message_delta` 被 Claude Code CLI 压成每 turn 末单发（spike3 长输出 4704tok/42s 仍单发实证）。生成中走文本估算（CJK/1.7 + ASCII/4），turn 末 `result.modelUsage` 精确值兜底。
- **D2 估算 ephemeral 不落库**：`token-rate-tick` 走 eventBus → safeSend 直达 renderer，绝不进 ingest/token_usage 表（不变量 1）。
- **D3 现有精确链路字节级不动**：assistant 帧采集 + result correction + DB max-merge + daily/topToday 全保留，估算纯旁路叠加。
- **D4 顺带根治 tok/s 恒为 0**：CHANGELOG_204 未结，生成中 assistant 帧 output_tokens≈0，DB poll 60s 窗口空 → rate 恒 0。流式实时估算从根上解决。
- **D5 codex 无此能力**：codex 无 stream_event → 永不进 live → header 对 codex bucket 走 poll 60s 窗口值。零代码，天然退化。
- **D6 GC retention = 365d 默认，0=关闭**：token_usage 是 daily dashboard 唯一历史源，retention 比 session/message 30d 宽松得多。
- **D7 实施顺序 = 先实现后 review**（plan design 双对抗收口 + 用户示意本批跳过实施期对抗）。
- **D8 渲染集 = fresh-live ∪ poll 并集 + live-first 排名 comparator**（HIGH-1 双方独立）：tuple `(hasFreshLive desc, liveTps desc, pollOutput desc)`，保证窄头 Top-N 不被 idle 高累计 bucket 挤出正在流式的 live bucket。
- **D9 turn 末即时校准**：done tick 删 live 后精确值走 onTokenUsageChanged 触发 refetch（debounce 500ms + latest-guard），让权威精确值即时接管 live 归零位置，不等 2500ms poll 闪烁。

### 不变量

1. 估算值绝不落库
2. estimateTokensFromText 纯函数（单测可覆盖）
3. stream_event 分支异常隔离（整体 try/catch + clearLiveTokenEstimate 自身 try/catch）
4. 现有 token-usage 精确链路行为字节级不变
5. facade import 不变（仅 translateSdkMessage / pushFileChangeIntent / consumePendingFileChangeIntent / maybeEmitImageFileChanged 导出，移走零外部影响）
6. 单文件 ≤500 LOC（sdk-message-translate 529→408）
7. WINDOW_MS SSOT 不变（@shared/model-normalize WINDOW_MS=60000）
8. normalizeModel bucketKey SSOT（fixture test-model-x lowercase fallback）
9. 渲染集是 fresh-live ∪ poll 并集
10. turn 末即时校准无 poll 延迟
11. LIVE_STALE_MS + 排名 comparator + fresh-live 聚合是 SSOT（lib/live-rate 抽 shared，Header + DataPanel 同一份）
12. liveBySession 无孤儿增长（applyLiveTick 机会式 prune + LIVE_STALE_MS=1500）

### 验证

```
$ pnpm typecheck → tsc --noEmit -p tsconfig.json  绿（Phase 6+7 改完）
$ git log --oneline origin/main..worktree-tok-rate-realtime-streaming-20260603
  8961b77 feat(token-usage): Phase 6-7 GC wiring + DataPanel live override
  3228372 wip(tok-rate): Phase 1-5 流式 tok/s 实时化（estimate·末尾校准）
$ git push -u origin worktree-tok-rate-realtime-streaming-20260603  成功
```

预期 dev 实测：开 app 问第一句（pure-text turn），header 顶栏即显示正在流式的 bucket tok/s 实时跳动（不再「先归零等一周期」闪烁），turn 末精确值（result.modelUsage）即时接管；codex session 天然退化走 60s 窗口；LifecycleSection UI 出现「Token 统计保留」NumberInput，0 = 永久 / 365 默认。

### 已知 trade-off / 残留

- **估算误差**：CJK/1.7 + ASCII/4 是粗近似（display-only），result.modelUsage 末尾校准兜底。
- **throttle 丢精度**：250ms 内多帧合并，EMA α=0.4 折中；极短 turn <250ms 可能一次 tick 都不发就 done（可接受一闪）。
- **decay 时机**：崩溃/abort 无 result done tick 时靠 LIVE_STALE_MS(1.5s) + poll(2.5s) 回落，最坏滞留 ~2.5s。
- **staleness 闪烁**：tool 执行 gap >1.5s 时 live entry 转 stale → 回落 poll 值（生成中≈0）→ header 短暂掉 0 → 下条 message 又跳回，display-only 可接受。
- **多 session 并发 IPC 量**：N session × 4 tick/s，典型 1-3 session 无压力；deep-review 10+ reviewer 并发时 40+ tick/s safeSend 安全。
- **thinking 模型稀疏**：opus thinking-max delta avg ~942ms → tick 稀疏跳动（EMA 平滑部分缓解）。
- **GC 删统计源**：tokenUsageRetentionDays 设太短会吞 daily dashboard 历史（默认 365 + jsdoc 警示 + 0=永久 + UI 可调）。
