/**
 * 跨进程共享：会话总结记录类型。
 */

/**
 * 周期总结单次模型调用的固定上限。它保护后台并发槽，不属于用户可调的产品行为。
 * 与续接检查点的后台生成预算保持同一宽泛档位。
 */
export const PERIODIC_SUMMARY_TIMEOUT_MS = 5 * 60 * 1_000;

export interface SummaryRecord {
  id: number;
  sessionId: string;
  content: string;
  trigger: 'time' | 'event-count' | 'manual';
  ts: number;
  /** Immutable event-revision boundary covered by this summary. */
  sourceEventRevision: number;
  /** Destructive-rebuild epoch captured with sourceEventRevision. */
  sourceRebuildAfterRevision: number;
  /** Makes degraded summaries explicit instead of presenting them as normal LLM output. */
  generationSource: 'llm' | 'assistant-fallback' | 'stats-fallback';
}
