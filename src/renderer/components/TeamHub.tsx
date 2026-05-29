import { useEffect, useState, type JSX } from 'react';
import type { AgentDeckTeam } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import log from '@renderer/utils/logger';
import { TeamDetail } from './TeamDetail';

const logger = log.scope('renderer-team-hub');

/**
 * R3.E7 (PR-B) 重写 — Universal Team Backend TeamHub。
 *
 * 数据源 = `window.api.listAgentDeckTeams()`，不再依赖 fs ~/.claude/teams/。
 * 老 fs watcher / SQL distinctTeamNames 全废。
 *
 * 当前是「最小可用」版本：列 active team 一行带 name + memberCount + lastEventAt 摘要 +
 * 跳转入口。完整 TeamDetail 在子组件继续做（cross-adapter member 列表 + send_message UI +
 * recent messages 时间线）。
 */
export function TeamHub({
  onOpenSession,
}: {
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [teams, setTeams] = useState<AgentDeckTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const sessions = useSessionStore((s) => s.sessions);

  useEffect(() => {
    let aborted = false;
    const fetch = (): void => {
      void window.api
        .listAgentDeckTeams({ includeArchived: false })
        .then((rows) => {
          if (!aborted) {
            setTeams(rows);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          logger.warn('[team-hub] list failed:', err);
          if (!aborted) setLoading(false);
        });
    };
    fetch();
    const off = window.api.onAgentDeckTeamChanged(() => {
      fetch();
    });
    return () => {
      aborted = true;
      off();
    };
  }, []);

  if (selectedTeamId) {
    return (
      <TeamDetail
        teamId={selectedTeamId}
        onBack={() => setSelectedTeamId(null)}
        onOpenSession={onOpenSession}
      />
    );
  }

  if (loading) {
    return <div className="px-3 py-4 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (teams.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">暂无团队</div>
        <div className="text-[10px] leading-relaxed text-deck-muted/70">
          让 AI 在会话中创建团队后，会显示在这里。
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
      <ol className="flex flex-col gap-2">
        {teams.map((t) => {
          const memberCount = (t.members ?? []).length;
          const sessionList = (t.members ?? [])
            .map((m) => sessions.get(m.sessionId))
            .filter((s): s is NonNullable<typeof s> => !!s);
          const lastEventAt =
            sessionList.length > 0
              ? Math.max(...sessionList.map((s) => s.lastEventAt))
              : t.createdAt;
          return (
            <li
              key={t.id}
              className="rounded border border-deck-border bg-white/[0.02] px-3 py-2 hover:bg-white/[0.04] cursor-pointer"
              onClick={() => setSelectedTeamId(t.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-deck-text truncate">{t.name}</div>
                  <div className="text-[10px] text-deck-muted">
                    {memberCount} 名成员 · 最近活跃{' '}
                    {new Date(lastEventAt).toLocaleString()}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export type { AgentDeckTeam };
