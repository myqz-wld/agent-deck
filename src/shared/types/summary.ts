/**
 * 跨进程共享：会话总结记录类型。
 */

export interface SummaryRecord {
  id: number;
  sessionId: string;
  content: string;
  trigger: 'time' | 'event-count' | 'manual';
  ts: number;
}
