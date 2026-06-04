/**
 * 跨进程共享：token 使用统计类型（plan model-token-stats-and-dashboard-20260602）。
 *
 * 三类形态：
 * - **TokenUsagePayload**：`token-usage` AgentEvent 的 payload（采集层 emit → ingest 落库）
 * - **TokenRateRow** / **TokenDailyRow**：IPC 查询返回行（main repo → renderer）
 * - **TokenUsageChangedEvent**：main → renderer push 通知（daily/rates 数据变更，触发 refetch）
 * - **TokenRateTickEvent**：main → renderer push 的生成中 tok/s 估算展示态（不落库）
 *
 * 仅依赖标准库；列名 camelCase（DB 层 snake_case 在 token-usage-repo 内转换）。
 */

/**
 * `token-usage` 事件 payload。claude assistant message / codex turn.completed 采集后 emit。
 * - messageId：claude assistant 用 BetaMessage.id；claude result correction 用 synthetic id；
 *   codex 无 → null
 * - model：原始 model id（claude BetaMessage.model / result.modelUsage key / codex 取 sessions.model）；
 *   归一在写库时算
 * - 4 指标：cache_* 缺省填 0（codex 无 cache_creation；claude cache_* 可能为 null）
 */
export interface TokenUsagePayload {
  messageId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * 按 model bucket 聚合的速率/总量行（today / ratesSince 查询返回）。
 * - bucketKey：归一 model bucket（GROUP BY 维度）
 * - outputTokens：该 bucket 在查询窗口内的 output token 总和
 *   （Top3 排名用今日总量；token/s = ratesSince 窗口总量 ÷ 窗口秒数，renderer 算）
 */
export interface TokenRateRow {
  bucketKey: string;
  outputTokens: number;
}

/**
 * 按 model bucket × 本地日期聚合的每日明细行（dailyByModel 查询返回，数据 tab 表格用）。
 * - day：本地日期 'YYYY-MM-DD'（SQL date(ts/1000,'unixepoch','localtime')）
 * - 4 指标：该 bucket 当天的 input/output/cacheRead/cacheCreation token 总和
 */
export interface TokenDailyRow {
  bucketKey: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** main → renderer push：token_usage 有新数据（renderer 据此 debounce refetch）。 */
export interface TokenUsageChangedEvent {
  sessionId: string;
  ts: number;
}

/** main → renderer push：生成中 tok/s 估算 tick。display-only，不写 token_usage。 */
export interface TokenRateTickEvent {
  sessionId: string;
  bucketKey: string;
  tps: number;
  ts: number;
  /** turn 结束 / session 结束时清掉该 session 的 live 展示态。 */
  done?: boolean;
}
