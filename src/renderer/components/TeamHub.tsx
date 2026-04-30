import { useCallback, useEffect, useState, type JSX } from 'react';
import type { TeamSnapshot, TeamSummary } from '@shared/types';
import { TeamDetail } from './TeamDetail';

/**
 * Agent Teams M2 — 团队列表面板。
 *
 * 数据源 = `window.api.listTeams()`，主进程合并 SQL `distinctTeamNames` + fs
 * `~/.claude/teams/` 子目录两个源（fs 可能有 Claude 已建但应用层无 session 的 team；
 * SQL 可能有 teamName 标过但 Claude 还没真建 team 的会话）。
 *
 * 不在这里订阅 fs 变化（list 是聚合视图，fs 单点变化触发 list 全量 re-fetch 没意义）；
 * 用 5s polling 兜底 + 监听 session-* IPC 事件触发 re-fetch（sessionCount 会变）。
 */
export function TeamHub({
  onOpenSession,
}: {
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.listTeams();
      setTeams(list);
      setError(null);
    } catch (err) {
      setError(`拉团队列表失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // session 增删改 → sessionCount / lastEventAt 可能变 → 兜底 polling 5s 一次
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (selected) {
    return (
      <TeamDetail
        name={selected}
        onBack={() => {
          setSelected(null);
          void refresh();
        }}
        onOpenSession={onOpenSession}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
      <header className="mb-2 flex items-center gap-2 text-[11px]">
        <span className="font-medium">团队</span>
        <span className="text-deck-muted/70">({teams.length})</span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15"
        >
          刷新
        </button>
      </header>
      {error && (
        <div className="mb-2 rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
          {error}
        </div>
      )}
      {loading && teams.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-deck-muted">读取中…</div>
      ) : teams.length === 0 ? (
        <div className="rounded border border-deck-border/40 bg-white/[0.02] p-3 text-[11px] text-deck-muted">
          没有团队。
          <br />
          <span className="text-[10px] text-deck-muted/70">
            打开一个会话填 team 名（设置面板里启用「Agent Teams」），让 Claude 在会话里
            创建 team（自然语言：<code className="rounded bg-white/5 px-1">Create an agent team named X with...</code>），
            团队会出现在这里。
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {teams.map((t) => (
            <li key={t.name}>
              <button
                type="button"
                onClick={() => setSelected(t.name)}
                className="block w-full rounded-lg border border-deck-border bg-white/[0.02] px-3 py-2 text-left transition hover:border-white/20 hover:bg-white/[0.06]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px]">🛡</span>
                  <span className="flex-1 truncate text-[12px] font-medium">{t.name}</span>
                  <span className="text-[10px] text-deck-muted/70">
                    {t.sessionCount} session{t.sessionCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-deck-muted">
                  <StatusChip ok={t.hasConfig} okText="config ✓" badText="无 config" />
                  <StatusChip ok={t.hasTasks} okText="tasks ✓" badText="无 tasks" />
                  {t.lastEventAt !== null && (
                    <span className="ml-auto text-[9px] text-deck-muted/60">
                      {formatRelative(t.lastEventAt)}
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusChip({
  ok,
  okText,
  badText,
}: {
  ok: boolean;
  okText: string;
  badText: string;
}): JSX.Element {
  return (
    <span
      className={`rounded px-1 py-0.5 text-[9px] ${
        ok ? 'bg-status-working/15 text-status-working' : 'bg-white/8 text-deck-muted/80'
      }`}
    >
      {ok ? okText : badText}
    </span>
  );
}

/** 简易相对时间格式：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// re-export for convenience
export type { TeamSnapshot };
