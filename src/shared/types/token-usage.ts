/**
 * 跨进程共享：token 使用统计类型（plan model-token-stats-and-dashboard-20260602）。
 *
 * 三类形态：
 * - **TokenUsagePayload**：`token-usage` AgentEvent 的 payload（采集层 emit → ingest 落库）
 * - **TokenRateRow** / **TokenDailyRow**：IPC 查询返回行（main repo → renderer）
 * - **TokenUsageChangedEvent**：main → renderer push 通知（daily/rates 数据变更，触发 refetch）
 * - **TokenRateTickEvent**：main → renderer push 的 tok/s 估算展示态（不落库）
 *
 * 仅依赖标准库；列名 camelCase（DB 层 snake_case 在 token-usage-repo 内转换）。
 */
import type { GrokUsageWatermark } from './session';

/** Metrics that one logical usage row participates in. Null within the scope means unknown. */
export const TOKEN_USAGE_METRIC = {
  total: 1 << 0,
  input: 1 << 1,
  output: 1 << 2,
  reasoning: 1 << 3,
  cacheRead: 1 << 4,
  cacheCreation: 1 << 5,
} as const;
export const TOKEN_USAGE_ALL_METRICS =
  TOKEN_USAGE_METRIC.total |
  TOKEN_USAGE_METRIC.input |
  TOKEN_USAGE_METRIC.output |
  TOKEN_USAGE_METRIC.reasoning |
  TOKEN_USAGE_METRIC.cacheRead |
  TOKEN_USAGE_METRIC.cacheCreation;

/**
 * `token-usage` 事件 payload。Claude assistant message / Codex turn.completed / Grok
 * `_x.ai/session/update` turn_completed 采集后 emit。
 * - messageId：claude assistant 用 BetaMessage.id；claude result correction 用 synthetic id；
 *   codex 无 → null
 * - model：原始 model id（claude BetaMessage.model / result.modelUsage key / codex 取 sessions.model）；
 *   归一在写库时算
 * - 指标：只记录 provider 明确返回的计数；未返回时保留 null
 *   （Claude 的近似 thinking-token 事件不进入累计或持久化）
 */
export interface TokenUsagePayload {
  messageId: string | null;
  model: string | null;
  /** Exact provider-reported total; do not synthesize when absent. */
  totalTokens?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /**
   * Internal applicability mask. Omitted means every metric participates. This is distinct from
   * presence: a scoped metric with null is unknown, while an out-of-scope metric is not part of
   * this additive row (for example exact but unattributed multi-model Claude reasoning).
   */
  metricScope?: number;
  /**
   * Internal Grok durability metadata. When present, main commits this cumulative accounting
   * frontier in the same SQLite transaction as the usage row. Historical corrections may carry
   * only the safely corrected turn-start frontier while a later snapshot is still in flight.
   */
  grokUsageWatermark?: GrokUsageWatermark;
  /**
   * Internal in-memory correlation metadata. These metrics are present in an exact cumulative ACP
   * snapshot, but their current-turn delta is unknown because the persisted turn-start was absent.
   * A matching extension may fill the row without advancing those frontier metrics again.
   */
  grokFrontierCoveredMetricScope?: number;
  /**
   * Internal Grok late-correlation key. The canonical provider prompt id replaces this provisional
   * standard-fallback row atomically, so history backfill cannot double-count the turn.
   */
  replacesMessageId?: string | null;
  /**
   * Internal Grok lifecycle marker. False means this is a correction for an already completed
   * turn; the runtime must persist it without completing or clearing the currently active tok/s
   * state.
   */
  grokAffectsCurrentTurn?: boolean;
}

/** Token 查询选项；历史 Grok 回填只由数据页按需开启，避免拖慢应用启动。 */
export interface TokenUsageQueryOptions {
  includeGrokHistory?: boolean;
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
 * - inputTokens：provider 原始上报的输入 token 总和（仅作兼容保留）
 * - inputTotalTokens：按 adapter 统一后的输入总量，缓存读/写已计入
 * - outputTokens：输出总量，推理 token 已包含在内
 * - reasoning/cacheRead/cacheCreation：对应总量中的分项
 */
export interface TokenDailyRow {
  bucketKey: string;
  day: string;
  /** Exact provider total, available only when every row in the bucket/day reports it. */
  providerTotalTokens: number | null;
  providerTotalApplicable: boolean;
  inputTokens: number | null;
  inputApplicable: boolean;
  inputTotalTokens: number | null;
  inputTotalApplicable: boolean;
  outputTokens: number | null;
  outputApplicable: boolean;
  reasoningTokens: number | null;
  reasoningApplicable: boolean;
  cacheReadTokens: number | null;
  cacheReadApplicable: boolean;
  cacheCreationTokens: number | null;
  cacheCreationApplicable: boolean;
}

/** main → renderer push：token_usage 有新数据（renderer 据此 debounce refetch）。 */
export interface TokenUsageChangedEvent {
  sessionId: string;
  ts: number;
}

/** main → renderer push：tok/s 估算 tick。display-only，不写 token_usage。 */
export interface TokenRateTickEvent {
  sessionId: string;
  bucketKey: string;
  tps: number;
  ts: number;
  /** turn 失败 / session 结束时清掉该 session 的 live 展示态。 */
  done?: boolean;
}
