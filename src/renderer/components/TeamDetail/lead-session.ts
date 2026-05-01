import type { TeamSnapshot } from '@shared/types';

/**
 * 取一个 lead session 候选给 SendToTeammate：
 * 优先 active > dormant > closed；同 lifecycle 取 lastEventAt 最大的（最新）。
 * 没有 sessions 返回 null（SendToTeammate 不渲染）。
 */
export function pickLeadSession(
  snap: TeamSnapshot,
): { id: string; agentId: string; title: string } | null {
  if (snap.sessions.length === 0) return null;
  const ranked = [...snap.sessions].sort((a, b) => {
    const ord = (l: string): number => (l === 'active' ? 0 : l === 'dormant' ? 1 : 2);
    const diff = ord(a.lifecycle) - ord(b.lifecycle);
    if (diff !== 0) return diff;
    return b.lastEventAt - a.lastEventAt;
  });
  return { id: ranked[0].id, agentId: ranked[0].agentId, title: ranked[0].title };
}
