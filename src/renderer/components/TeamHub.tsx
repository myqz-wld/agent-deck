import { useEffect, useState, type JSX } from 'react';
import type { TeamSummaryDto } from '@contracts/index';
import log from '@renderer/utils/logger';
import { TeamDetail } from './TeamDetail';
import { useTeamDataSource } from './team-data-source';
import type { RemoteSessionSourceView } from '../remote-host/source-types';

const logger = log.scope('renderer-team-hub');

/**
 * R3.E7 (PR-B) 重写 — Universal Team Backend TeamHub。
 *
 * Local 与 Remote 共用 TeamDataSource + TeamDetail；数据、写入与刷新始终绑定当前来源。
 *
 * 列表展示 active team 的 memberCount / lastEventAt，详情继续展示 cross-adapter 成员、
 * lineage、pending、事件、任务与消息。
 */
export function TeamHub({
  onOpenSession,
  remoteSource = null,
}: {
  onOpenSession: (sessionId: string) => void;
  remoteSource?: RemoteSessionSourceView | null;
}): JSX.Element {
  const source = useTeamDataSource(remoteSource);
  const [teams, setTeams] = useState<TeamSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    const fetch = (): void => {
      setListError(null);
      void source.list()
        .then((result) => {
          if (!aborted) {
            setTeams(result.teams);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          logger.warn('[team-hub] list failed:', err);
          if (!aborted) {
            setListError('读取团队列表失败，请稍后重试。');
            setLoading(false);
          }
        });
    };
    fetch();
    const off = source.subscribe(() => {
      fetch();
    });
    return () => {
      aborted = true;
      off();
    };
  }, [source]);

  if (selectedTeamId) {
    return (
      <TeamDetail
        teamId={selectedTeamId}
        source={source}
        onBack={() => setSelectedTeamId(null)}
        onOpenSession={onOpenSession}
      />
    );
  }

  if (loading) {
    return <div className="px-3 py-4 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (listError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-status-waiting/90">
        {listError}
      </div>
    );
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
                    {t.memberCount} 名成员 · 最近活跃{' '}
                    {new Date(t.lastEventAt).toLocaleString()}
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
