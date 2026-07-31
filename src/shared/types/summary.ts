/**
 * 跨进程共享：会话总结记录类型。
 */

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
