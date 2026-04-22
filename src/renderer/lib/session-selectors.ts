import type { SessionRecord } from '@shared/types';

/**
 * 「实时面板」口径：lifecycle ∈ {active, dormant} 且未归档。
 *
 * 为什么 renderer 端要再过滤一次：
 * - main 端 sessionRepo.listActiveAndDormant 的 SQL 已经把 closed / archived 过滤掉了，
 *   首次 listSessions 拿到的就是干净集合
 * - 但 store 是「增量维护」的：当一条会话在运行时被归档（仅打 archived_at 标记，lifecycle 不变，
 *   见 CLAUDE.md「生命周期与归档正交」），或被 LifecycleScheduler 推到 lifecycle='closed'，
 *   main 都会 emit 'session-upserted'，store 的 upsertSession 不过滤照单收下
 * - 因此 header stats / SessionList 必须在使用前再过滤一次，与 SQL 口径对齐，
 *   否则会出现「N 会话」与下方实时列表实际可见数对不上的问题
 *
 * 同时按 lastEventAt 倒序，与 SQL 的 ORDER BY 一致。
 */
export function selectLiveSessions(
  sessions: Map<string, SessionRecord>,
): SessionRecord[] {
  return [...sessions.values()]
    .filter(
      (s) =>
        s.archivedAt === null &&
        (s.lifecycle === 'active' || s.lifecycle === 'dormant'),
    )
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
}
